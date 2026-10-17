# selvage-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent take part in a
[Selvage](https://github.com/selvage-protocol/specification) session: host a folder, or join an invite
link, read and edit the files the room shares, and see who else is in it.

It is a client of the session protocol, like the editor clients — it drives the same sync engine and
speaks the same wire, so an agent and a person edit the same documents and see each other's changes.

```
npx selvage-mcp
```

Licensed under `MIT OR Apache-2.0`.
