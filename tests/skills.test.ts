import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'skills');
const SRC = (function walk(d: string): string {
  return readdirSync(d, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? walk(join(d, e.name)) : readFileSync(join(d, e.name), 'utf8')))
    .join('\n');
})(join(ROOT, 'src'));

type Skill = { dir: string; name: string; description: string; tools: Set<string> };
const skills: Skill[] = readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const text = readFileSync(join(DIR, e.name, 'SKILL.md'), 'utf8');
    const fm = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(fm, `${e.name}: SKILL.md needs name + description frontmatter only`);
    const section = text.match(/## Tools\n([^\n]+)/);
    assert.ok(section, `${e.name}: needs a "## Tools" line`);
    return { dir: e.name, name: fm![1], description: fm![2], tools: new Set([...section![1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1])) };
  });

test('between 10 and 12 skills, one folder each', () => {
  assert.ok(skills.length >= 10 && skills.length <= 12, `have ${skills.length}`);
});

test('names match folders, are unique and descriptions say when to use them', () => {
  for (const s of skills) {
    assert.equal(s.name, s.dir);
    assert.match(s.name, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(s.description.length >= 40 && s.description.length <= 300, s.name);
    assert.match(s.description, /Result|result/);
  }
  assert.equal(new Set(skills.map((s) => s.name)).size, skills.length);
});

test('every tool a skill names really exists in the server source', () => {
  for (const s of skills) {
    assert.ok(s.tools.size >= 3, `${s.name} lists too few tools`);
    for (const t of s.tools) assert.ok(new RegExp(`['"\`]${t}['"\`]`).test(SRC), `${s.name}: unknown tool ${t}`);
  }
});

test('no overlap: skills differ by 2+ tools, unless one is a strict superset (advanced version)', () => {
  for (let i = 0; i < skills.length; i++)
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i], b = skills[j];
      const onlyA = [...a.tools].filter((t) => !b.tools.has(t)).length;
      const onlyB = [...b.tools].filter((t) => !a.tools.has(t)).length;
      const advanced = onlyA === 0 || onlyB === 0;
      assert.ok(advanced || onlyA + onlyB >= 2, `${a.name} and ${b.name} are too similar`);
      if (advanced) assert.ok(onlyA + onlyB >= 1, `${a.name} and ${b.name} use identical tools`);
    }
});

test('tools that merge, approve or dispatch are never named', () => {
  for (const s of skills) for (const t of ['pr_merge', 'pr_approve', 'actions_dispatch']) assert.ok(!s.tools.has(t));
  assert.ok(existsSync(join(DIR, 'README.md')));
});
