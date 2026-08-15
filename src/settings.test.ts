import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { REGISTRY, declareSetting, declaredSettings, type SettingDeclaration } from './settings.ts';
import { translate } from './i18n/catalogue.ts';
import { LOCALES } from './i18n/locale.ts';

/** An env reader over a plain object, standing in for a runtime's own. */
const reader = (env: Record<string, string>) => (key: string) => env[key];

const find = (settings: ReturnType<typeof declaredSettings>, key: string) => {
  const hit = settings.find((s) => s.key === key);
  assert.ok(hit, `${key} is not declared`);
  return hit;
};

test('the read gate fails closed: a value is served only where it is declared', () => {
  // Every secret in the registry is reported by presence alone. Asserted over
  // the whole registry rather than over a list repeated here, so a setting added
  // without thinking about exposure is caught by this test rather than by a leak.
  const secret = reader({
    TIMELINES_DATABASE_URL: 'postgres://user:hunter2@db.example.com/x',
    TIMELINES_SUPABASE_SERVICE_KEY: 'ey.super.secret',
    MCP_API_TOKEN: 'tok_live_abcdef',
    TIMELINES_BOOTSTRAP_ADMIN: 'owner@example.com',
  });
  const served = JSON.stringify(declaredSettings(secret));
  for (const leak of ['hunter2', 'ey.super.secret', 'tok_live_abcdef', 'owner@example.com']) {
    assert.equal(served.includes(leak), false, `${leak} reached the response`);
  }
});

test('presence is still reported for a withheld value', () => {
  // The point of withholding the value is not to hide whether it is set: „the
  // master key is unset" is exactly what an operator debugging „nobody can
  // invite" needs, and it is not a secret.
  const set = find(declaredSettings(reader({ TIMELINES_BOOTSTRAP_ADMIN: 'owner@example.com' })), 'TIMELINES_BOOTSTRAP_ADMIN');
  assert.equal(set.set, true);
  assert.equal('value' in set, false);

  const unset = find(declaredSettings(reader({})), 'TIMELINES_BOOTSTRAP_ADMIN');
  assert.equal(unset.set, false);
  assert.equal('value' in unset, false);
});

test('a withheld value is absent, never masked', () => {
  // A mask is still a claim about length and shape, and a client that decides to
  // render the field anyway would print it. An absent key cannot be un-redacted.
  const s = find(declaredSettings(reader({ MCP_API_TOKEN: 'tok_live_abcdef' })), 'MCP_API_TOKEN');
  assert.equal(Object.prototype.hasOwnProperty.call(s, 'value'), false);
});

test('the served value is the effective one, not what was typed', () => {
  // MCP_TOKEN_ROLE=nonsense acts as editor (serviceRoleFrom). A page showing
  // „nonsense" would describe an instance that does not exist.
  const bogus = find(declaredSettings(reader({ MCP_TOKEN_ROLE: 'nonsense' })), 'MCP_TOKEN_ROLE');
  assert.equal(bogus.value, 'editor');

  const asked = find(declaredSettings(reader({ MCP_TOKEN_ROLE: 'viewer' })), 'MCP_TOKEN_ROLE');
  assert.equal(asked.value, 'viewer');

  // Only the literal `true` turns the switch on — the same reading the gate uses.
  assert.equal(find(declaredSettings(reader({ TIMELINES_ACCESS_CONTROL: '1' })), 'TIMELINES_ACCESS_CONTROL').value, 'false');
  assert.equal(find(declaredSettings(reader({ TIMELINES_ACCESS_CONTROL: 'true' })), 'TIMELINES_ACCESS_CONTROL').value, 'true');
});

test('an unset setting with a documented default reports the default and set: false', () => {
  // Two different facts, and the interface needs both: „editor" is what the
  // instance does, `set: false` is why nothing in the dashboard says so.
  const role = find(declaredSettings(reader({})), 'MCP_TOKEN_ROLE');
  assert.equal(role.value, 'editor');
  assert.equal(role.set, false);

  const dir = find(declaredSettings(reader({})), 'TIMELINES_DATA_DIR');
  assert.equal(dir.value, 'data');
  assert.equal(dir.set, false);
});

test('whitespace is not a value', () => {
  // A variable set to spaces in a hosting dashboard is a typo, not a setting.
  const s = find(declaredSettings(reader({ ALLOWED_EMAIL_DOMAINS: '   ' })), 'ALLOWED_EMAIL_DOMAINS');
  assert.equal(s.set, false);
});

test('a declaration carries no prose about itself', () => {
  // The area shows label, variable name, value and a „Herkunft" badge. It used to
  // repeat a sentence per group saying where the value lives, which the badge
  // already says — see „Interface text" in AGENTS.md.
  for (const s of declaredSettings(reader({}))) {
    assert.equal((s as Record<string, unknown>).why, undefined, `${s.key} carries prose`);
  }
});

test('keys are unique and every declaration is renderable', () => {
  const keys = REGISTRY.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, 'a key is declared twice');
  for (const d of REGISTRY) {
    // A declaration now names catalogue keys rather than carrying finished text,
    // so „renderable" means those keys resolve — in *both* languages. The type
    // already forbids a key the catalogue does not have; what it cannot see is a
    // key that resolves to itself because the catalogue holds an empty string.
    for (const locale of LOCALES) {
      assert.notEqual(translate(locale, d.labelKey), d.labelKey, `${d.key} has no ${locale} label`);
      assert.notEqual(translate(locale, d.groupKey), d.groupKey, `${d.key} has no ${locale} group`);
    }
  }
});

test('a setting is served in the language of whoever asked', () => {
  const de = find(declaredSettings(reader({}), 'de'), 'TIMELINES_ACCESS_CONTROL');
  const en = find(declaredSettings(reader({}), 'en'), 'TIMELINES_ACCESS_CONTROL');
  assert.equal(de.label, 'Zugriffskontrolle');
  assert.equal(en.label, 'Access control');
  assert.equal(de.group, 'Zugang');
  assert.equal(en.group, 'Access');
  // Only the text moves. The identity, the origin and the read gate are facts
  // about the deployment and say the same thing to everybody.
  assert.equal(de.key, en.key);
  assert.equal(de.home, en.home);
  assert.equal(de.value, en.value);
});

test('adding a setting is a declaration and nothing else', () => {
  // The acceptance criterion for whether the spine is real: a setting the
  // interface has never heard of has to come out fully renderable — label,
  // group, home, editability, reason and the gate applied — with no branch
  // anywhere keyed on its name. Asserted against a declaration built here rather
  // than one in the registry, because a registry entry proves only that the
  // registry works.
  // The label and group are catalogue keys now, and the invented one names keys
  // the catalogue has never heard of — deliberately, and cast past the type that
  // normally forbids it. That is what keeps this test testing the mechanism: a
  // declaration using real keys would only prove that the catalogue has entries.
  //
  // What changed with the catalogue, stated plainly, because „a declaration and
  // nothing else" is the criterion this test carries: adding a setting is now a
  // line here **plus its two translations**. The coupling that sentence was
  // written against is untouched — no rendering code learns a setting's name, and
  // the page still renders declarations it cannot enumerate. A translated
  // interface has to keep its text somewhere, and the alternative is the finished
  // German string in the declaration, which is what this change removed.
  const invented = {
    key: 'INVENTED_SETTING',
    groupKey: 'invented.group',
    labelKey: 'invented.label',
    // A home no declaration in the registry uses yet, and an editable one, so
    // this also asserts that neither depends on a case being present today.
    home: 'db',
    editable: true,
    expose: 'value',
  } as unknown as SettingDeclaration;

  // An unknown key resolves to itself rather than to a blank. The row therefore
  // comes out fully rendered and *says which key is missing* — a blank label
  // would be indistinguishable from a layout bug, and this is the one path where
  // the type cannot help, because a plugin or a future runtime can hand this
  // function a declaration the catalogue was not compiled with.
  assert.deepEqual(declareSetting(invented, 'x'), {
    key: 'INVENTED_SETTING',
    group: 'invented.group',
    label: 'invented.label',
    home: 'db',
    editable: true,
    set: true,
    value: 'x',
  });

  // The same declaration without `expose` is withheld by the gate alone, with
  // nothing anywhere naming INVENTED_SETTING.
  const withheld = declareSetting({ ...invented, expose: undefined }, 'x');
  assert.equal(withheld.set, true);
  assert.equal('value' in withheld, false);
});
