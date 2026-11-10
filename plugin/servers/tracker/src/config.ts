// Config sections (spec §6) and a small validator. Each field: type plus optional enum/items.
// Unknown keys are rejected so typos surface at setup instead of silently doing nothing.

import { isRecord, oneOf } from './util.ts';

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';

export interface FieldSpec {
  type: FieldType | readonly FieldType[];
  enum?: readonly string[];
  items?: FieldSpec;
  fields?: Readonly<Record<string, FieldSpec>>;
  required?: readonly string[];
}

export interface SectionSchema {
  required?: readonly string[];
  fields: Readonly<Record<string, FieldSpec>>;
}

export interface PayFloor {
  amount: number;
  currency: string;
  period?: 'year' | 'month' | 'day' | 'hour';
  basis?: 'gross' | 'net';
  contract_type?: string | null;
}

export interface FiltersConfig {
  work_mode: ('remote' | 'hybrid' | 'onsite')[];
  hybrid?: { max_days_per_week?: number | null; cities?: string[] };
  residence_country: string;
  timezone: string;
  overlap_window?: string;
  work_authorisation?: string[];
  pay_floor: PayFloor;
  pay_rule_with_equity?: string;
  band_rule?: string;
  excluded_industries?: string[];
  excluded_role_shapes?: string[];
  culture_red_lines?: string[];
}

export interface PrefsConfig {
  titles?: string[];
  seniority?: string[];
  stage?: string[];
  stack_want?: string[];
  stack_avoid?: string[];
  domains_like?: string[];
  contract_ok?: boolean;
  availability?: string;
}

export interface WritingConfig {
  voice_profile?: string | null;
  humanizer?: boolean;
  max_words_cover_note?: number;
  never_volunteer_gaps?: boolean;
  signature_style?: 'name_only' | 'name_and_links';
}

export interface AccountsConfig {
  job_inbox_email: string;
  invite_calendar: string;
  connected_calendar?: string | null;
  chrome_autofill_risk?: string | null;
}

export interface AutonomyConfig {
  auto_apply?: boolean;
  unattended?: string[];
  needs_user?: string[];
}

export interface ScheduleConfig {
  daily?: { days?: string; time?: string; tz?: string };
  desktop_usually_on?: string | null;
  report_delivery?: 'file' | 'artifact' | 'email_draft';
}

export interface SourcesConfig {
  enabled?: string[];
  need_login?: string[];
  disabled?: string[];
  boards?: string[];
}

export interface CapabilitiesConfig {
  connectors?: Record<string, unknown>;
  browser?: string | null;
  local_folder?: boolean | string | null;
  detected_at?: string;
}

export interface ConfigSections {
  filters: FiltersConfig;
  prefs: PrefsConfig;
  writing: WritingConfig;
  accounts: AccountsConfig;
  autonomy: AutonomyConfig;
  schedule: ScheduleConfig;
  sources: SourcesConfig;
  capabilities: CapabilitiesConfig;
}

export type SectionName = keyof ConfigSections;

// What get_profile returns: each section as saved (validated), its defaults, or null.
export type Profile = { [K in SectionName]: Partial<ConfigSections[K]> | null };

const str: FieldSpec = { type: 'string' };
const strOrNull: FieldSpec = { type: ['string', 'null'] };
const strList: FieldSpec = { type: 'array', items: { type: 'string' } };
const bool: FieldSpec = { type: 'boolean' };
const WORK_MODES = ['remote', 'hybrid', 'onsite'];

export const CONFIG_SCHEMA: { [K in SectionName]: SectionSchema } = {
  filters: {
    required: ['work_mode', 'residence_country', 'timezone', 'pay_floor'],
    fields: {
      work_mode: { type: 'array', items: { type: 'string', enum: WORK_MODES } },
      hybrid: { type: 'object', fields: { max_days_per_week: { type: ['number', 'null'] }, cities: strList } },
      residence_country: str,
      timezone: str,
      overlap_window: str,
      work_authorisation: strList,
      pay_floor: {
        type: 'object',
        required: ['amount', 'currency'],
        fields: {
          amount: { type: 'number' },
          currency: str,
          period: { type: 'string', enum: ['year', 'month', 'day', 'hour'] },
          basis: { type: 'string', enum: ['gross', 'net'] },
          contract_type: strOrNull,
        },
      },
      pay_rule_with_equity: str,
      band_rule: str,
      excluded_industries: strList,
      excluded_role_shapes: strList,
      culture_red_lines: strList,
    },
  },
  prefs: {
    fields: {
      titles: strList,
      seniority: strList,
      stage: strList,
      stack_want: strList,
      stack_avoid: strList,
      domains_like: strList,
      contract_ok: bool,
      availability: str,
    },
  },
  writing: {
    fields: {
      voice_profile: strOrNull,
      humanizer: bool,
      max_words_cover_note: { type: 'number' },
      never_volunteer_gaps: bool,
      signature_style: { type: 'string', enum: ['name_only', 'name_and_links'] },
    },
  },
  accounts: {
    required: ['job_inbox_email', 'invite_calendar'],
    fields: {
      job_inbox_email: str,
      invite_calendar: str,
      connected_calendar: strOrNull,
      chrome_autofill_risk: strOrNull,
    },
  },
  autonomy: {
    fields: { auto_apply: bool, unattended: strList, needs_user: strList },
  },
  schedule: {
    fields: {
      daily: { type: 'object', fields: { days: str, time: str, tz: str } },
      desktop_usually_on: strOrNull,
      report_delivery: { type: 'string', enum: ['file', 'artifact', 'email_draft'] },
    },
  },
  sources: {
    fields: { enabled: strList, need_login: strList, disabled: strList, boards: strList },
  },
  capabilities: {
    fields: {
      connectors: { type: 'object' },
      browser: strOrNull,
      local_folder: { type: ['boolean', 'string', 'null'] },
      detected_at: str,
    },
  },
};

// The legacy action lists cannot grant submit permission; only the explicit auto_apply preference can.
export const ALWAYS_NEEDS_USER = ['submit', 'send', 'delete', 'consent', 'personal_data', 'account_login'];

// Object.keys loses the key type; CONFIG_SCHEMA's type guarantees these are exactly the section names.
export const SECTION_NAMES = Object.keys(CONFIG_SCHEMA) as SectionName[];

export const DEFAULTS: { [K in SectionName]?: Partial<ConfigSections[K]> } = {
  writing: { humanizer: true, max_words_cover_note: 200, never_volunteer_gaps: true, signature_style: 'name_only', voice_profile: null },
  autonomy: { auto_apply: false, unattended: ['search', 'verify', 'score', 'draft_note', 'draft_email', 'record'], needs_user: [...ALWAYS_NEEDS_USER] },
  filters: {
    band_rule: 'drop only if the band MAXIMUM is below floor; straddling bands are kept',
    pay_rule_with_equity: "floor unchanged; equity may justify a 'negotiable' answer inside the band",
  },
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function check(spec: FieldSpec, value: unknown, path: string, errors: string[]): void {
  const types: readonly string[] = typeof spec.type === 'string' ? [spec.type] : spec.type;
  const t = typeOf(value);
  if (!types.includes(t)) {
    errors.push(`${path}: expected ${types.join(' or ')}, got ${t}`);
    return;
  }
  if (spec.enum && !oneOf(spec.enum, value)) errors.push(`${path}: "${value}" is not one of ${spec.enum.join(', ')}`);
  const { items, fields } = spec;
  if (Array.isArray(value) && items) value.forEach((item, i) => {
    check(items, item, `${path}[${i}]`, errors);
  });
  if (isRecord(value) && fields) checkObject({ required: spec.required, fields }, value, path, errors);
}

function checkObject(spec: SectionSchema, obj: Record<string, unknown>, path: string, errors: string[]): void {
  for (const key of spec.required || []) {
    if (obj[key] === undefined) errors.push(`${path}.${key}: required`);
  }
  for (const [key, val] of Object.entries(obj)) {
    const f = spec.fields[key];
    if (!f) {
      errors.push(`${path}.${key}: unknown field`);
      continue;
    }
    if (val !== undefined) check(f, val, `${path}.${key}`, errors);
  }
}

function describe(spec: FieldSpec): string {
  if (spec.enum) return spec.enum.join('|');
  if (spec.items) return `array of ${describe(spec.items)}`;
  if (spec.fields) return `{ ${describeFields({ required: spec.required, fields: spec.fields })} }`;
  return typeof spec.type === 'string' ? spec.type : spec.type.join('|');
}

function describeFields(spec: SectionSchema): string {
  return Object.entries(spec.fields)
    .map(([key, f]) => `${key}${spec.required?.includes(key) ? ' (required)' : ''}: ${describe(f)}`)
    .join(', ');
}

// One line per section, appended to save_config errors so the agent can fix the call without guessing field names.
export function describeSection(section: SectionName): string {
  return `${section} fields: ${describeFields(CONFIG_SCHEMA[section])}`;
}

export function validateSection(section: string, data: unknown): string[] {
  const spec = oneOf(SECTION_NAMES, section) ? CONFIG_SCHEMA[section] : undefined;
  if (!spec) return [`unknown section "${section}". Known: ${Object.keys(CONFIG_SCHEMA).join(', ')}`];
  if (!isRecord(data)) return [`${section}: expected an object`];
  const errors: string[] = [];
  checkObject(spec, data, section, errors);
  if (section === 'autonomy' && Array.isArray(data.unattended)) {
    const bad = data.unattended.filter((a) => ALWAYS_NEEDS_USER.includes(a));
    if (bad.length) errors.push(`autonomy.unattended: ${bad.join(', ')} always need the user and cannot run unattended`);
  }
  return errors;
}
