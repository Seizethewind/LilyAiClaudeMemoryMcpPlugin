import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkills, buildSkillTools, skillsHint } from '../src/skills';

const DIR = join(__dirname, '..', 'skills');
const dirs = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

test('every skill folder is served, byte for byte, from the files', async () => {
  const skills = loadSkills();
  assert.deepEqual(skills.map((s) => s.name), [...dirs].sort());
  const [tool] = buildSkillTools(skills);
  for (const d of dirs) {
    const r = await tool.handler({ name: d });
    assert.equal(r.skill, readFileSync(join(DIR, d, 'SKILL.md'), 'utf8'));
  }
});

test('listing returns name + description only, and an unknown name explains itself', async () => {
  const [tool] = buildSkillTools(loadSkills());
  const list = await tool.handler({});
  assert.equal(list.skills.length, dirs.length);
  for (const s of list.skills) assert.deepEqual(Object.keys(s).sort(), ['description', 'name']);
  await assert.rejects(() => tool.handler({ name: '../etc/passwd' }), /Unknown skill/);
  await assert.rejects(() => tool.handler({ name: 'nope' }), /Available: /);
});

test('the always-on hint names every skill but carries no skill text', () => {
  const skills = loadSkills();
  const hint = skillsHint(skills);
  for (const s of skills) assert.ok(hint.includes(s.name));
  assert.ok(hint.length < 600, `hint is ${hint.length} chars`);
  assert.ok(!hint.includes('## Steps'));
});

test('no skills folder, or a malformed one, means no tool and no hint (server still starts)', () => {
  assert.deepEqual(loadSkills(join(tmpdir(), 'does-not-exist-xyz')), []);
  const d = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(d, 'bad'));
  writeFileSync(join(d, 'bad', 'SKILL.md'), 'no frontmatter');
  mkdirSync(join(d, 'wrong-name'));
  writeFileSync(join(d, 'wrong-name', 'SKILL.md'), '---\nname: other\ndescription: x\n---\n');
  assert.deepEqual(loadSkills(d), []);
  assert.deepEqual(buildSkillTools([]), []);
  assert.equal(skillsHint([]), '');
});
