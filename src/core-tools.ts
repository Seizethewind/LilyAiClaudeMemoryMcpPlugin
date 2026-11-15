/**
 * The core file and branch tools: get_file_contents, list_branches, create_branch,
 * create_or_update_file, delete_file, push_files. Moved out of server.ts as is.
 */
import type { GithubCore } from './github-core';

export function buildCoreTools(core: GithubCore): any[] {
  const { githubRequest, assertRepoAllowed, assertWriteAllowed, getDefaultBranch, encodePath } = core;
  void getDefaultBranch;
  return [
    {
      name: 'get_file_contents',
      description:
        'Get the contents and blob SHA of a file in an allowed repo. If the path is a directory (or empty for the repo root), returns a listing of its entries instead.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          path: { type: 'string', description: 'File or directory path. Use an empty string for the repo root.' },
          ref: { type: 'string', description: 'Branch, tag or SHA. Defaults to the repo default branch.' },
        },
        required: ['owner', 'repo', 'path'],
      },
      handler: async ({ owner, repo, path: p, ref }) => {
        assertRepoAllowed(owner, repo);
        const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
        const res = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${encodePath(p)}${q}`);
        if (res.status >= 400) throw new Error(`GitHub error ${res.status}: ${JSON.stringify(res.body)}`);

        // Directory: GitHub returns an array of entries.
        if (Array.isArray(res.body)) {
          return {
            path: p || '/',
            type: 'dir',
            entries: res.body.map((e) => ({
              name: e.name,
              path: e.path,
              type: e.type,
              sha: e.sha,
              size: e.size,
            })),
          };
        }

        const content = res.body.encoding === 'base64' ? Buffer.from(res.body.content, 'base64').toString('utf8') : res.body.content;
        return { sha: res.body.sha, path: res.body.path, content };
      },
    },
    {
      name: 'create_or_update_file',
      description: 'Create or update a single file with one commit. Pass sha when overwriting an existing file.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string', description: 'Raw file content, not base64-encoded.' },
          message: { type: 'string' },
          branch: { type: 'string' },
          sha: { type: 'string', description: 'Required when overwriting an existing file.' },
        },
        required: ['owner', 'repo', 'path', 'content', 'message', 'branch'],
      },
      handler: async ({ owner, repo, path: p, content, message, branch, sha }) => {
        await assertWriteAllowed(owner, repo, branch);
        const body = {
          message,
          branch,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        };
        const res = await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${encodePath(p)}`, body);
        if (res.status >= 400) throw new Error(`GitHub error ${res.status}: ${JSON.stringify(res.body)}`);
        return { commit: res.body.commit && res.body.commit.sha, path: p };
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file from a repo.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          path: { type: 'string' },
          message: { type: 'string' },
          branch: { type: 'string' },
          sha: { type: 'string', description: 'Current blob SHA of the file (get via get_file_contents).' },
        },
        required: ['owner', 'repo', 'path', 'message', 'branch', 'sha'],
      },
      handler: async ({ owner, repo, path: p, message, branch, sha }) => {
        await assertWriteAllowed(owner, repo, branch);
        const res = await githubRequest('DELETE', `/repos/${owner}/${repo}/contents/${encodePath(p)}`, {
          message,
          branch,
          sha,
        });
        if (res.status >= 400) throw new Error(`GitHub error ${res.status}: ${JSON.stringify(res.body)}`);
        return { deleted: p };
      },
    },
    {
      name: 'list_branches',
      description: 'List branches in a repo.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' } },
        required: ['owner', 'repo'],
      },
      handler: async ({ owner, repo }) => {
        assertRepoAllowed(owner, repo);
        const res = await githubRequest('GET', `/repos/${owner}/${repo}/branches`);
        if (res.status >= 400) throw new Error(`GitHub error ${res.status}: ${JSON.stringify(res.body)}`);
        return res.body.map((b) => ({ name: b.name, sha: b.commit && b.commit.sha }));
      },
    },
    {
      name: 'create_branch',
      description: 'Create a new branch from an existing branch (defaults to the repo default branch).',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          branch: { type: 'string' },
          from_branch: { type: 'string' },
        },
        required: ['owner', 'repo', 'branch'],
      },
      handler: async ({ owner, repo, branch, from_branch }) => {
        await assertWriteAllowed(owner, repo, null);
        let base = from_branch;
        if (!base) {
          const repoRes = await githubRequest('GET', `/repos/${owner}/${repo}`);
          if (repoRes.status >= 400) throw new Error(`GitHub error ${repoRes.status}: ${JSON.stringify(repoRes.body)}`);
          base = repoRes.body.default_branch;
        }
        const refRes = await githubRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
        if (refRes.status >= 400) throw new Error(`GitHub error ${refRes.status}: ${JSON.stringify(refRes.body)}`);
        const sha = refRes.body.object.sha;
        const createRes = await githubRequest('POST', `/repos/${owner}/${repo}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha,
        });
        if (createRes.status >= 400) throw new Error(`GitHub error ${createRes.status}: ${JSON.stringify(createRes.body)}`);
        return { branch, from: base, sha };
      },
    },
    {
      name: 'push_files',
      description: 'Commit multiple files at once (atomic single commit) using the git trees API.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          branch: { type: 'string' },
          message: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
        },
        required: ['owner', 'repo', 'branch', 'message', 'files'],
      },
      handler: async ({ owner, repo, branch, message, files }) => {
        await assertWriteAllowed(owner, repo, branch);
        const refRes = await githubRequest('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        if (refRes.status >= 400) throw new Error(`GitHub error ${refRes.status}: ${JSON.stringify(refRes.body)}`);
        const baseCommitSha = refRes.body.object.sha;

        const commitRes = await githubRequest('GET', `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
        if (commitRes.status >= 400) throw new Error(`GitHub error ${commitRes.status}: ${JSON.stringify(commitRes.body)}`);
        const baseTreeSha = commitRes.body.tree.sha;

        const blobs: any[] = [];
        for (const f of files) {
          const blobRes = await githubRequest('POST', `/repos/${owner}/${repo}/git/blobs`, {
            content: Buffer.from(f.content, 'utf8').toString('base64'),
            encoding: 'base64',
          });
          if (blobRes.status >= 400) throw new Error(`GitHub error ${blobRes.status}: ${JSON.stringify(blobRes.body)}`);
          blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: blobRes.body.sha });
        }

        const treeRes = await githubRequest('POST', `/repos/${owner}/${repo}/git/trees`, {
          base_tree: baseTreeSha,
          tree: blobs,
        });
        if (treeRes.status >= 400) throw new Error(`GitHub error ${treeRes.status}: ${JSON.stringify(treeRes.body)}`);

        const newCommitRes = await githubRequest('POST', `/repos/${owner}/${repo}/git/commits`, {
          message,
          tree: treeRes.body.sha,
          parents: [baseCommitSha],
        });
        if (newCommitRes.status >= 400) throw new Error(`GitHub error ${newCommitRes.status}: ${JSON.stringify(newCommitRes.body)}`);

        const updateRefRes = await githubRequest('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
          sha: newCommitRes.body.sha,
        });
        if (updateRefRes.status >= 400) throw new Error(`GitHub error ${updateRefRes.status}: ${JSON.stringify(updateRefRes.body)}`);

        return { commit: newCommitRes.body.sha, filesCommitted: files.map((f) => f.path) };
      },
    },
  ];
}
