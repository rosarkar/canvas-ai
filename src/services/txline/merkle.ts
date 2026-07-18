/**
 * Merkle-proof verification — the cryptographic core of "provably fair".
 *
 * TxLINE anchors each day's scores as a Merkle root in a `daily_scores_merkle_roots`
 * account on Solana. A result is proven by an inclusion proof: a leaf (the fixture's
 * score record) plus a list of sibling hashes that recompute, hop by hop, to the
 * published root. If the recomputed root equals the on-chain root, the result is
 * provably part of the anchored data — it cannot have been fudged after the fact.
 *
 * This module implements that verification in plain TypeScript so it runs anywhere:
 *  - LIVE: verify TxLINE's REST `ProofNode[]` against the on-chain root bytes.
 *  - DEMO: build a real tree over the day's results and produce a proof a judge can
 *    verify by hand — the exact mechanism, shown on labelled sample data.
 *
 * Leaves and internal nodes are domain-separated (0x00 / 0x01 prefixes, the
 * OpenZeppelin convention) so a proof for an internal node can never be replayed
 * as a leaf. `is_right_sibling` mirrors TxLINE's `ProofNode` position flag.
 */
import { createHash } from "node:crypto";

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}

/** Hash a leaf's raw bytes (domain-separated). */
export function hashLeaf(data: string | Buffer): Buffer {
  return sha256(LEAF_PREFIX, typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

/** Hash two child nodes into their parent (domain-separated, order-preserving). */
export function hashNode(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** One sibling on the path from a leaf to the root. */
export interface ProofNode {
  /** The sibling hash (32 bytes). */
  hash: Buffer;
  /** True if the sibling sits to the RIGHT of the running hash (TxLINE's `is_right_sibling`). */
  isRightSibling: boolean;
}

/** A human-inspectable record of one verification hop (for the UI walk-through). */
export interface ProofStep {
  index: number;
  siblingHex: string;
  isRightSibling: boolean;
  /** The running hash AFTER combining with this sibling. */
  resultHex: string;
}

export interface ProofVerification {
  ok: boolean;
  leafHex: string;
  computedRootHex: string;
  expectedRootHex: string;
  steps: ProofStep[];
}

/**
 * Verify a Merkle inclusion proof: fold `leaf` up through `proof`, hop by hop,
 * and check the result equals `root`. Returns the full hop trace either way.
 */
export function verifyProof(leaf: Buffer, proof: ProofNode[], root: Buffer): ProofVerification {
  let running = leaf;
  const steps: ProofStep[] = [];
  proof.forEach((node, index) => {
    running = node.isRightSibling ? hashNode(running, node.hash) : hashNode(node.hash, running);
    steps.push({
      index,
      siblingHex: node.hash.toString("hex"),
      isRightSibling: node.isRightSibling,
      resultHex: running.toString("hex"),
    });
  });
  return {
    ok: running.equals(root),
    leafHex: leaf.toString("hex"),
    computedRootHex: running.toString("hex"),
    expectedRootHex: root.toString("hex"),
    steps,
  };
}

export interface MerkleTree {
  root: Buffer;
  leaves: Buffer[];
  /** Inclusion proof for the leaf at `index`. */
  proofFor(index: number): ProofNode[];
}

/**
 * Build a Merkle tree over pre-hashed leaves. Odd nodes are promoted (hashed with
 * themselves) so every level halves cleanly — the standard "duplicate last" rule.
 */
export function buildTree(leaves: Buffer[]): MerkleTree {
  if (leaves.length === 0) throw new Error("buildTree needs at least one leaf");
  const layers: Buffer[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = i + 1 < prev.length ? prev[i + 1] : prev[i]; // promote the odd tail
      next.push(hashNode(left, right));
    }
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1][0],
    leaves,
    proofFor(index: number): ProofNode[] {
      if (index < 0 || index >= leaves.length) throw new Error(`leaf index ${index} out of range`);
      const proof: ProofNode[] = [];
      let idx = index;
      for (let level = 0; level < layers.length - 1; level++) {
        const nodes = layers[level];
        const isRightNode = idx % 2 === 1;
        const pairIdx = isRightNode ? idx - 1 : idx + 1;
        const sibling = pairIdx < nodes.length ? nodes[pairIdx] : nodes[idx]; // promoted odd tail
        // If our node is on the LEFT, its sibling is on the RIGHT, and vice-versa.
        proof.push({ hash: sibling, isRightSibling: !isRightNode });
        idx = Math.floor(idx / 2);
      }
      return proof;
    },
  };
}

/** Canonical leaf encoding for a fixture's final result (stable + human-readable). */
export function fixtureResultLeaf(params: {
  fixtureId: number | string;
  winner: string;
  homeGoals: number;
  awayGoals: number;
  epochDay: number;
}): Buffer {
  const canonical = `txline:v1:${params.epochDay}:${params.fixtureId}:${params.winner}:${params.homeGoals}-${params.awayGoals}`;
  return hashLeaf(canonical);
}

/** Parse a TxLINE REST `ProofNode` (hash as base64/hex string or byte array) into our shape. */
export function toProofNode(raw: unknown): ProofNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { hash?: unknown; is_right_sibling?: unknown; isRightSibling?: unknown };
  const isRight = Boolean(r.is_right_sibling ?? r.isRightSibling);
  let hash: Buffer | null = null;
  if (Array.isArray(r.hash)) hash = Buffer.from(r.hash as number[]);
  else if (typeof r.hash === "string") {
    hash = /^[0-9a-fA-F]{64}$/.test(r.hash) ? Buffer.from(r.hash, "hex") : Buffer.from(r.hash, "base64");
  }
  if (!hash || hash.length !== 32) return null;
  return { hash, isRightSibling: isRight };
}
