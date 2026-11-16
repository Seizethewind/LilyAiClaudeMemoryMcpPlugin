/** Repository keys (owner/name): validation, normalisation and similar-name suggestions. */

export const GENERAL = 'general';
const REPO_KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const REPO_HELP =
  'Pass the repository as "owner/name" (a github.com URL also works), or "general" when the work belongs to no repository. Call memory_repos to see which repositories have memory.';

export function isRepoKey(s: string): boolean {
  return REPO_KEY_RE.test(s) && !/^\.{1,2}$/.test(s.split('/')[1] ?? '');
}

/** Canonical form of a repository: lowercase "owner/name" key plus the spelling the caller used. */
export function normalizeRepo(input: unknown): { key: string; display: string } {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error(`repo is required. ${REPO_HELP}`);
  if (raw.toLowerCase() === GENERAL) return { key: GENERAL, display: GENERAL };
  let s = raw;
  let fromUrl = false;
  const m = s.match(/^(?:git@github\.com:|(?:https?:\/\/|ssh:\/\/git@)?(?:www\.)?github\.com\/)(.+)$/i);
  if (m) { s = m[1]; fromUrl = true; }
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  const bad = () => new Error(`"${raw.slice(0, 80)}" is not a valid repository name. ${REPO_HELP}`);
  if (parts.length < 2 || (parts.length > 2 && !fromUrl)) throw bad();
  const name = parts[1].replace(/\.git$/i, '');
  const key = `${parts[0]}/${name}`.toLowerCase();
  if (!isRepoKey(key)) throw bad();
  return { key, display: `${parts[0]}/${name}` };
}

function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Known repositories that look like the same one under a typo, another owner, or a near-identical name. */
export function similarRepos(key: string, known: { repo: string; display: string }[]): { repo: string; why: string }[] {
  const [o, n] = key.split('/');
  const out: { repo: string; why: string }[] = [];
  for (const k of known) {
    if (k.repo === key || k.repo === GENERAL) continue;
    const [ko, kn] = k.repo.split('/');
    const limit = n.length <= 4 ? 1 : 2;
    let why = '';
    if (kn === n) why = 'same repository name under a different owner';
    else if (ko === o && lev(n, kn) <= limit) why = 'same owner, near-identical name (typo?)';
    else if (lev(key, k.repo) <= 2) why = 'near-identical full name (typo?)';
    if (why) out.push({ repo: k.display, why });
  }
  return out.slice(0, 5);
}
