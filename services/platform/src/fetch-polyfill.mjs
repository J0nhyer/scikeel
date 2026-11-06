// Node 22.23.4 and 24.22.2 bundle undici versions that crash the process on
// an unread response body when the peer closes the socket (undici #5360,
// fixed by #5474). Use the pinned npm undici as the platform's global fetch.
import { fetch } from "undici";

globalThis.fetch = fetch;
