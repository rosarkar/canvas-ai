import { describe, expect, it } from "vitest";
import {
  buildTree,
  fixtureResultLeaf,
  hashLeaf,
  hashNode,
  toProofNode,
  verifyProof,
} from "./merkle.js";

describe("merkle", () => {
  const leaves = ["a", "b", "c", "d", "e"].map((x) => hashLeaf(x));

  it("a valid inclusion proof recomputes the root for every leaf", () => {
    const tree = buildTree(leaves);
    leaves.forEach((leaf, i) => {
      const v = verifyProof(leaf, tree.proofFor(i), tree.root);
      expect(v.ok).toBe(true);
      expect(v.computedRootHex).toBe(tree.root.toString("hex"));
      expect(v.steps.length).toBeGreaterThan(0);
    });
  });

  it("tampering with the leaf breaks the proof (soundness)", () => {
    const tree = buildTree(leaves);
    const v = verifyProof(hashLeaf("a-tampered"), tree.proofFor(0), tree.root);
    expect(v.ok).toBe(false);
    expect(v.computedRootHex).not.toBe(v.expectedRootHex);
  });

  it("tampering with a sibling hash breaks the proof", () => {
    const tree = buildTree(leaves);
    const proof = tree.proofFor(2);
    proof[0].hash = Buffer.alloc(32, 0xff);
    expect(verifyProof(leaves[2], proof, tree.root).ok).toBe(false);
  });

  it("single-leaf tree: root is the leaf and the proof is empty", () => {
    const tree = buildTree([hashLeaf("only")]);
    expect(tree.root.equals(hashLeaf("only"))).toBe(true);
    expect(verifyProof(hashLeaf("only"), tree.proofFor(0), tree.root).ok).toBe(true);
  });

  it("leaf and node hashing are domain-separated (a 2nd-preimage can't be forged)", () => {
    const a = hashLeaf("x");
    const b = hashLeaf("y");
    // An attacker who knows two leaf hashes cannot present them as a leaf: the
    // node combiner uses a different prefix than the leaf hasher.
    expect(hashNode(a, b).equals(hashLeaf(Buffer.concat([a, b])))).toBe(false);
  });

  it("fixtureResultLeaf is deterministic and result-sensitive", () => {
    const base = { fixtureId: 42, winner: "HOME", homeGoals: 2, awayGoals: 1, epochDay: 20652 };
    expect(fixtureResultLeaf(base).equals(fixtureResultLeaf(base))).toBe(true);
    expect(fixtureResultLeaf(base).equals(fixtureResultLeaf({ ...base, awayGoals: 2 }))).toBe(false);
  });

  it("toProofNode accepts hex, base64, and byte-array hashes", () => {
    const bytes = Array.from({ length: 32 }, (_, i) => i);
    const buf = Buffer.from(bytes);
    const fromArr = toProofNode({ hash: bytes, is_right_sibling: true });
    const fromHex = toProofNode({ hash: buf.toString("hex"), isRightSibling: true });
    const fromB64 = toProofNode({ hash: buf.toString("base64"), is_right_sibling: true });
    expect(fromArr?.hash.equals(buf)).toBe(true);
    expect(fromHex?.hash.equals(buf)).toBe(true);
    expect(fromB64?.hash.equals(buf)).toBe(true);
    expect(fromArr?.isRightSibling).toBe(true);
    expect(toProofNode({ hash: "tooshort" })).toBeNull();
  });
});
