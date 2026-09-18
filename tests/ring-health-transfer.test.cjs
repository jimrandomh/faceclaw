const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("ring health drains ACK-paced pages before advancing and aborts on write failure", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "faceclaw-ring-health-"));
  const javaBin = (name) => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
  const source = fs.readFileSync(path.join(__dirname,
    "../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java"), "utf8");
  // Compile the actual worker methods with a fake GATT transport. This keeps
  // Android out of the JVM test without copying the transfer implementation.
  const methods = ["requestRingHealth", "awaitRingHealthRsp", "awaitRingHealthDataIdle", "flushRingOutbound", "runRingWorker"]
    .map((name) => {
      const match = source.match(new RegExp(`    private (?:boolean|int|void) ${name}\\([^]*?^    }`, "m"));
      if (!match) throw new Error(`Missing production method: ${name}`);
      return match[0];
    }).join("\n");
  for (const signature of ["@Override public void run()", "private void connectLoopOnce()"]) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0);
    const body = source.slice(start, source.indexOf("\n    }", start));
    assert.doesNotMatch(body, /tryConnectRing\(|requestRingHealth\(|flushRingOutbound\(|runRequestedRingHealthPull\(/,
      "the glasses sender must not call blocking ring operations");
  }
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures/RingHealthTransferTest.java"), "utf8");
  const harness = path.join(directory, "RingHealthTransferTest.java");
  fs.writeFileSync(harness, fixture.replace("// TRANSFER_METHODS", methods));
  try {
    execFileSync(javaBin("javac"), ["-d", directory, harness,
      path.join(__dirname, "../App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/RingProtocol.java"),
      path.join(__dirname, "../notes/ring-protocol-selftest/RingProtocolSelfTest.java"),
    ], { stdio: "pipe" });
    execFileSync(javaBin("java"), ["-ea", "-cp", directory, "com.faceclaw.app.RingHealthTransferTest"],
      { stdio: "pipe", timeout: 15000 });
    execFileSync(javaBin("java"), ["-ea", "-cp", directory, "com.faceclaw.app.RingProtocolSelfTest"],
      { stdio: "pipe", timeout: 15000 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
