/**
 * The GitHub REST helper and the guard rails every GitHub tool shares: reads follow ALLOWED_REPOS,
 * writes follow WRITE_REPOS, direct writes to a default branch are refused unless explicitly allowed.
 * Moved out of server.ts as is; createGithubCore takes the settings it needs.
 */
import * as https from 'node:https';

export type GithubCore = ReturnType<typeof createGithubCore>;

export function createGithubCore(cfg: { token: string | undefined; allowedRepos: Set<string>; writeRepos: Set<string>; allowDefaultBranchWrites: boolean; request?: (method: string, path: string, body?: any) => Promise<{ status: number; body: any; headers?: any }> }) {
  const GITHUB_TOKEN = cfg.token;
  const ALLOWED_REPOS = cfg.allowedRepos;
  const WRITE_REPOS = cfg.writeRepos;
  const ALLOW_DEFAULT_BRANCH_WRITES = cfg.allowDefaultBranchWrites;

  // ---------------------------------------------------------------------------
  // GitHub REST API helper
  // ---------------------------------------------------------------------------

  function realGithubRequest(method, path, body?): Promise<{ status: number; body: any; headers?: any }> {
    return new Promise<{ status: number; body: any; headers?: any }>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request(
        {
          hostname: 'api.github.com',
          path,
          method,
          headers: {
            'User-Agent': 'lily-github-mcp-bridge',
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            let parsed: any = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch (e) {
              parsed = raw;
            }
            resolve({ status: res.statusCode, body: parsed, headers: res.headers });
          });
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // `request` can be replaced (tests); by default it talks to api.github.com.
  const githubRequest: (method: string, path: string, body?: any) => Promise<{ status: number; body: any; headers?: any }> = cfg.request || realGithubRequest;

  // Exact "owner/repo" match, org-wide "owner/*" match, or global "*" match.
  function repoListAllows(list: Set<string>, owner, repo) {
    return list.has(`${owner}/${repo}`) || list.has(`${owner}/*`) || list.has('*');
  }

  function assertRepoAllowed(owner, repo) {
    const key = `${owner}/${repo}`;
    if (!repoListAllows(ALLOWED_REPOS, owner, repo)) {
      const err: any = new Error(`Repo "${key}" is not in ALLOWED_REPOS for this bridge.`);
      err.isToolError = true;
      throw err;
    }
  }

  // Default branch per repo, cached briefly so a burst of writes costs one lookup.
  const defaultBranchCache = new Map<string, { branch: string; at: number }>();
  const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000;

  async function getDefaultBranch(owner, repo): Promise<string> {
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = defaultBranchCache.get(key);
    if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.branch;
    const res = await githubRequest('GET', `/repos/${owner}/${repo}`);
    if (res.status >= 400) throw new Error(`GitHub error ${res.status}: ${JSON.stringify(res.body)}`);
    defaultBranchCache.set(key, { branch: res.body.default_branch, at: Date.now() });
    return res.body.default_branch;
  }

  // Gate for every tool that changes a repo. Commits and deletes pass their
  // `branch` so direct writes to the default branch can be refused (a missing
  // branch means GitHub would use the default branch, so it is refused too).
  // Pass `null` for writes that don't commit to a branch (create_branch).
  async function assertWriteAllowed(owner, repo, branch: string | null | undefined) {
    assertRepoAllowed(owner, repo);
    const key = `${owner}/${repo}`;
    if (!repoListAllows(WRITE_REPOS, owner, repo)) {
      const err: any = new Error(`Repo "${key}" is read-only: it is not in WRITE_REPOS for this bridge.`);
      err.isToolError = true;
      throw err;
    }
    if (branch === null || ALLOW_DEFAULT_BRANCH_WRITES) return;
    const def = await getDefaultBranch(owner, repo);
    if (!branch || String(branch) === def) {
      const err: any = new Error(
        `Direct writes to the default branch "${def}" of ${key} are blocked. Create a branch (create_branch), commit there, and open a pull request. ` +
          `(Set ALLOW_DEFAULT_BRANCH_WRITES=true on the server to allow this.)`
      );
      err.isToolError = true;
      throw err;
    }
  }

  // Encode a repo file path for use in a GitHub contents API URL. Each segment
  // is encoded on its own so "/" separators are preserved (encoding the whole
  // path would turn "src/foo.js" into "src%2Ffoo.js", which GitHub rejects).
  // Leading/trailing slashes are stripped; an empty path means the repo root.
  function encodePath(p) {
    return String(p || '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  }


  function downloadTail(url: string, maxBytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': 'lily-github-mcp-bridge' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`log download failed: HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c) => {
          chunks.push(c);
          size += c.length;
          while (size - chunks[0].length >= maxBytes) size -= chunks.shift()!.length; // keep only the tail
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').slice(-maxBytes)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error('log download timed out')));
    });
  }

  return { githubRequest, repoListAllows, assertRepoAllowed, getDefaultBranch, assertWriteAllowed, encodePath, downloadTail };
}
