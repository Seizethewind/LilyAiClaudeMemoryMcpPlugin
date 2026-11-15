/**
 * Serves the process skills in skills/ through one tool, so they work in any session that has this
 * connector, even where no skills are installed in Claude. The files stay the single source of truth:
 * nothing is copied into code, and get_skill returns exactly what is on disk.
 *
 * Only a one-line index goes into the always-on instructions (names only); the text of a skill
 * costs no context until get_skill is called.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SkillInfo = { name: string; description: string; body: string };

/** skills/ sits next to src/ and dist/, so ../skills works for both ts and compiled runs. */
export function loadSkills(dir = join(__dirname, '..', 'skills')): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = join(dir, e.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const body = readFileSync(file, 'utf8');
    const fm = body.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    if (!fm || fm[1] !== e.name) continue;
    out.push({ name: fm[1], description: fm[2], body });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsHint(skills: SkillInfo[]): string {
  if (!skills.length) return '';
  return `Process skills (${skills.map((s) => s.name).join(', ')}): when a request matches one of these jobs, call get_skill with its name and follow it. get_skill without a name lists them with descriptions.`;
}

export function buildSkillTools(skills: SkillInfo[]): any[] {
  if (!skills.length) return [];
  return [
    {
      name: 'get_skill',
      description:
        'Returns a process skill: the ordered steps, tools and result for one kind of job (starting or finishing work, shipping a PR, fixing CI, reviewing, triage, research). Without a name it lists the skills. Takes no action itself.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Skill name, e.g. ship-a-change. Omit to list all.' } },
        required: [],
      },
      handler: async ({ name }: { name?: string }) => {
        if (!name) return { skills: skills.map((s) => ({ name: s.name, description: s.description })) };
        const s = skills.find((x) => x.name === name);
        if (!s) throw new Error(`Unknown skill "${name}". Available: ${skills.map((x) => x.name).join(', ')}`);
        return { name: s.name, skill: s.body };
      },
    },
  ];
}
