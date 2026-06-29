// Type declarations for the DIG Browser injected `window.chia` provider.
//
// The provider (dig/provider/dig_provider.js) is the sole programmatic API an
// agent or dapp drives in the native DIG Browser. This `.d.ts` is the committed,
// machine-readable contract for it: identity, the method catalogue, the request
// surface, the events, and the stable thrown-error codes — so a consumer can
// introspect capabilities and branch on failures WITHOUT reading the source.
//
// It is byte-aligned with the dig-chrome-extension's `window.chia` provider and
// its wallet-methods.mjs WALLET_METHODS, so a dapp sees the same shape whether
// the user is on the native browser or the extension.

/** CHIP-0002 core methods (asset-generic; any CAT by assetId). */
export type Chip0002Method =
  | "chip0002_chainId"
  | "chip0002_connect"
  | "chip0002_getPublicKeys"
  | "chip0002_signMessage"
  | "chip0002_signCoinSpends"
  | "chip0002_getAssetBalance"
  | "chip0002_getAssetCoins";

/** chia_* methods (addresses, sends, NFTs, DIDs, offers). */
export type ChiaMethod =
  | "chia_getAddress"
  | "chia_signMessageByAddress"
  | "chia_send"
  | "chia_getTransactions"
  | "chia_getNfts"
  | "chia_transferNft"
  | "chia_mintNft"
  | "chia_bulkMintNfts"
  | "chia_getDids"
  | "chia_createDidWallet"
  | "chia_transferDid"
  | "chia_getOfferSummary"
  | "chia_createOffer"
  | "chia_takeOffer"
  | "chia_cancelOffer";

/**
 * The full supported method surface. `chip0002_getMethods` is the introspection
 * RPC (answered locally, returns the catalogue as `string[]`); `connect` is the
 * bare alias of `chip0002_connect`. Bare names (e.g. `"getPublicKeys"`) are also
 * accepted and namespaced to `chip0002_*`.
 */
export type WalletMethod = Chip0002Method | ChiaMethod;

/** Stable, documented thrown-error codes (standard injected-wallet convention). */
export interface DigProviderErrorCodes {
  /** 4001 — the user rejected the request / a connect is still pending approval. */
  USER_REJECTED: 4001;
  /** 4100 — origin not approved, or the wallet can't sign (watch-only/expired). */
  UNAUTHORIZED: 4100;
  /** 4200 — the wallet does not support the requested method. */
  UNSUPPORTED_METHOD: 4200;
  /** 4900 — the wallet bridge is unreachable or returned a malformed response. */
  WALLET_UNREACHABLE: 4900;
}

/** The numeric error code carried on a thrown {@link DigProviderError}. */
export type DigProviderErrorCode = 4001 | 4100 | 4200 | 4900;

/** Error thrown by `request()`/`connect()`. `code` is stable; branch on it. */
export interface DigProviderError extends Error {
  /** Stable machine code from {@link DigProviderErrorCodes}. */
  code: DigProviderErrorCode;
  /** True when a connect is pending the user's per-origin approval (code 4001). */
  pending?: boolean;
  /** The raw wallet transport status (HTTP-like), when one was returned. */
  status?: number;
}

/** Provider identity, machine-readable. */
export interface DigProviderInfo {
  /** Always true for a DIG-supplied provider. */
  isDIG: true;
  /** How wallet calls are brokered: `"native"` in DIG Browser (in-process Mojo). */
  transport: "native";
  /** Which DIG surface injected this provider. */
  edition: "browser";
  /** The user-facing scheme the browser registers (SYSTEM.md canonical). */
  scheme: "chia";
  /** The DIG Browser build version. */
  version: string;
}

/** Arguments to `window.chia.request`. */
export interface DigRequestArgs {
  /** A {@link WalletMethod}, the bare form of one, `connect`, or `getMethods`. */
  method: WalletMethod | "connect" | "chip0002_getMethods" | "getMethods" | string;
  /** Method params (CHIP-0002 / chia_* shapes). */
  params?: unknown;
}

/** The injected `window.chia` provider. */
export interface DigChiaProvider {
  /** Always true — distinguishes this from other injected providers. */
  readonly isDIG: true;
  /** True once the active origin has been approved via `connect()`. */
  isConnected: boolean;
  /** The DIG Browser build version (e.g. "149.0.7827.155"). */
  readonly version: string;
  /** Machine-readable provider identity. */
  readonly info: DigProviderInfo;
  /** The supported method catalogue (also via `request({method:"chip0002_getMethods"})`). */
  readonly methods: WalletMethod[];
  /** The stable thrown-error code enum. */
  readonly errorCodes: DigProviderErrorCodes;
  /**
   * CHIP-0002 entrypoint. Accepts bare or namespaced method names. Resolves with
   * the wallet's result, or rejects with a {@link DigProviderError}.
   * `request({method:"chip0002_getMethods"})` resolves with the method list
   * locally without touching the wallet bridge.
   */
  request(args: DigRequestArgs): Promise<unknown>;
  /**
   * Request per-origin approval. Resolves once the user approves (or with an
   * eager session); rejects with a {@link DigProviderError} on reject/timeout.
   */
  connect(eager?: boolean): Promise<unknown>;
  /** Subscribe to a provider event (e.g. `"connect"`). */
  on(event: string, handler: (data: unknown) => void): void;
  /** Unsubscribe a previously-registered handler. */
  off(event: string, handler: (data: unknown) => void): void;
}

declare global {
  interface Window {
    /** Present in the DIG Browser (and the DIG extension); CHIP-0002 wallet. */
    chia?: DigChiaProvider;
  }
  /** Dispatched on `window` once `window.chia` is installed. */
  interface WindowEventMap {
    "chia#initialized": Event;
  }
}

export {};
