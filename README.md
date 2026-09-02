# Social

Federated social for Möbius people. Three surfaces:

- **Board** — a public community feed hosted by a community host (any Möbius
  instance; yours by default).
- **Messages** — private 1:1 conversations delivered directly between Möbius
  instances. Each side stores only its own copy; no third party ever holds a
  conversation.
- **People** — search the community host's opt-in directory, or reach anyone
  directly by their instance address.

The server side lives in the platform's `/api/common` federation router
(protocol `common/0`): Ed25519-signed envelopes, a public actor card per
instance, and an inbox each instance exposes to its peers. This app is the
client UI; it only ever talks to its own server.

Conversation data lives in this app's per-app storage
(`conversations/<peer-host>/…`); incoming deliveries bump `state/version.json`,
which the open app watches to refresh live.
