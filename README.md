# Selvage for agents

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an agent take part in
a [Selvage session](https://github.com/selvage-protocol/specification): host a folder, or join an
invite link, and read, edit and write the files the room shares.

It is a client of the session protocol, like the editor clients: it drives the same sync engine
and speaks the same wire, so an agent and a person edit the same documents and see each other's
changes.

Status: v1 in progress. Hosting, joining by invite, and editing in both directions work today.

## Get it working

You need:

- Node 22.18 or newer on `PATH`. The sync engine runs at every end of a session, so an agent that
  edits a room runs the same code an editor does.
- A `selvaged` to connect to. Start one and note the address it prints.

It is a stdio server — one JSON-RPC message per line — and its diagnostics go to stderr. There are
two ways to start it, and they start the same program.

**From a checkout.** `npm ci` installs the dependencies and builds the runnable artifact, because
`prepare` runs `npm run build`: a bundle of the sources and the vendored engine, written to
`dist/`. Point a client at it:

```json
{
  "mcpServers": {
    "selvage": {
      "command": "node",
      "args": ["/path/to/mcp/dist/main.js"],
      "cwd": "/path/to/mcp",
      "env": {
        "SELVAGE_SERVER_URL": "ws://127.0.0.1:8080",
        "SELVAGE_DISPLAY_NAME": "agent"
      }
    }
  }
}
```

`dist/main.js` carries a shebang and the executable bit, so it is also the command `bin` names:
`selvage-mcp` and `node <path>/dist/main.js` are the same process. `npm run build` alone rebuilds
it. `src/main.ts` is the same server run straight from the sources — Node 22.18 strips the types
as it loads it — so `node <path>/src/main.ts` works too, with no build at all.

**From git, with no checkout.** `npx` fetches the repository, installs it, which runs the same
build, and starts the command the package declares:

```json
{
  "mcpServers": {
    "selvage": {
      "command": "npx",
      "args": ["-y", "github:selvage-protocol/mcp"],
      "env": {
        "SELVAGE_SERVER_URL": "ws://127.0.0.1:8080",
        "SELVAGE_DISPLAY_NAME": "agent"
      }
    }
  }
}
```

There is no `cwd` to set: the server reads its own `package.json` from where it was installed, and
everything else it needs arrives through the environment or through a tool call.

**The package is not on npm**, and `npx selvage-mcp` does not exist. It stays `private: true`:
publishing needs an account and a token for the scope, and that is not a decision this repository
takes on its own. The git form above is the same package a publish would carry.

`SELVAGE_SERVER_URL` is the Selvage server's address, and it matters because it is the only way
the address arrives without being asked for: a client starts this server as a subprocess and has
nothing to answer a question with, so `session_host` falls back to this variable when its
`server_url` argument is left out, and refuses, naming both, when neither is there. A bare
`ws://host:port` is enough — the engine adds the `/session` path — and what you hand it is the
address `selvaged` prints. `SELVAGE_DISPLAY_NAME` is the name the other seats see; without it
this server seats itself as `agent`.

A first session:

1. Start `selvaged` and note the address it prints.
2. Ask the agent to call `session_host` with the folder to share. It answers with the invite URL,
   fragment and all.
3. Hand that link to a person (`:SelvageJoin <invite>` in the Neovim client, or the VS Code one)
   or to a second agent's `session_join`. The fragment is the room's key.
4. Both read and edit the same files. A guest's edit arrives in the room and on the host's disk; a
   host's write arrives in every guest's `read_file`.

## Tools

| | |
|---|---|
| `session_host` | Share a folder and host the room. The folder is walked once, here. Answers with the room id, the path count and the invite URL. |
| `session_join` | Join a room from an invite URL, the fragment included. Answers with the room id, this seat's role, the participants and the path count. |
| `session_status` | Where this server stands: room, role, mode, granted paths, open documents, participants, and any problem the session could not fix. Answers with no session too. |
| `session_leave` | Leave the room and free the process to host or join again. A host leaving closes the room for everyone. |
| `list_paths` | The room's shared paths, sorted, filtered by `prefix` and bounded by `limit`; a cut answer says it was cut and names the limit. |
| `read_file` | The room's text for one shared path. |
| `edit_file` | Replace `old_string` with `new_string` in a shared file, refusing an absent or an ambiguous match unless `replace_all` is set. |
| `write_file` | Replace a shared file's whole text. |
| `list_participants` | One line per seat: name, role, whether it is this connection, and the cursor a seat publishes — which this server never does. |

## What it cannot do

- **A host cannot create a file its folder does not already hold.** The write side of the path
  clamp is a read: a write happens only for a path the folder already resolves to a plain file of
  it, so a path the room has and the folder does not is a recorded refusal, not a new file.
- **Nothing republishes the listing after the initial walk.** The paths a host's walk finds are
  the room's listing for the life of the session; a file added to the folder later is not listed
  until a new session, and no folder watcher runs on this side.
- **A guest writes nothing to disk.** The room's text lives in the agent's replica; a guest's
  edits go to the room and nowhere else. Hosting is the only direction that touches a disk.
- **The agent publishes an identity but no cursor.** A seat appears in the room with its name and
  its role, and nothing else: no selection and no caret. `list_participants` reads `no cursor
  seen` beside this server's seat, and an editor client draws it as a name without a cursor.
- **The invite fragment is a credential.** It is the room's key, so an invite link is as sensitive
  as the room itself: anything that holds the link can join and read what the host shares. A
  failed join reports the URL as `[invite]` rather than echoing the key.

## Tests

`npm run typecheck` and `npm test` are what CI runs, and they need nothing but Node: the suite
includes interop against a real third-party client, the official `@modelcontextprotocol/sdk`,
driving the shipped process.

`test/packed.test.ts` is the packaging proof rather than the exercise: it runs `npm pack` here,
installs the tarball into a scratch project outside this checkout, and drives the installed command
— not the sources — through `initialize` and `tools/list`. It fails, rather than skipping, when the
artifact is not in the tarball.

`npm run test:e2e` is the proof rather than the exercise: two MCP servers over their real stdio,
editing one room on a real `selvaged`, converging in both directions. It **fails** rather than
skipping when there is no server binary, naming the command that builds one, and finds the binary
through `SELVAGE_SELVAGED` or as a sibling `reference_server`'s build. CI does not run it, because
the runner has no such checkout; `scripts/ci-local.sh e2e` does.

`nix develop . --max-jobs 2 -c ./scripts/ci-local.sh all` runs this checkout's whole gate: lint,
checks, e2e, links.

## Licence

`MIT OR Apache-2.0`: `LICENSE-MIT` and `LICENSE-APACHE`.
