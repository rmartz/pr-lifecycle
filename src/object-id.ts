// Every value passed to git in argv is validated, so nothing from an API response
// can be read as an option (e.g. a "sha" of `--upload-pack=…`). A review marker's
// commit is checked the same way, since review bodies are attacker-controlled.
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Whether a value is a full hex git object id, safe for git's argv and API paths. */
export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}
