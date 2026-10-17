/**
 * The nine tools this server serves, as a caller reads them off `tools/list`. A list rather than
 * a count, and in the order a caller sorts them into, because the assertion worth making is that
 * the surface is these names — a tenth tool is a change to the protocol this server speaks.
 */

export const TOOL_NAMES = [
  'edit_file',
  'list_participants',
  'list_paths',
  'read_file',
  'session_host',
  'session_join',
  'session_leave',
  'session_status',
  'write_file',
];
