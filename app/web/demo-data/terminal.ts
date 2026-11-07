/**
 * Pretend terminal sessions on a pretend computer, for the Terminal demo
 * (g2mirror-client.webworker.ts). Scripted, deliberately modest, and honest about
 * it if you try to talk to them.
 */
export const DEMO_TERMINAL_SERVER_NAME = "demo-laptop";
export const DEMO_TERMINAL_URL = "g2mirror://demo@demo-laptop:8737";

const ESC = "\u001b";
const DIM = `${ESC}[2m`, BOLD = `${ESC}[1m`, RESET = `${ESC}[0m`;

type Step = { afterMs: number; text: string; bell?: boolean };

/** A coding agent working through a small fix, stopping to ask before it commits. */
const AGENT_SCRIPT: Step[] = [
  { afterMs: 400, text: `${BOLD}> Fix the tide table rounding bug from issue 112${RESET}\r\n\r\n` },
  { afterMs: 1600, text: `I'll start with the failing test.\r\n\r\n` },
  { afterMs: 1800, text: `${DIM}run${RESET} npm test -- tide-tables\r\n` },
  { afterMs: 2200, text: `  ${BOLD}FAIL${RESET} predicts low tide at the half hour\r\n    expected 14:30, received 14:29\r\n\r\n` },
  { afterMs: 2600, text: `The height is compared before it's rounded, so a tide\r\nexactly on the half hour lands one minute early.\r\n\r\n` },
  { afterMs: 2400, text: `${DIM}edit${RESET} src/tides/predict.ts\r\n  - if (height < lowest) lowest = height;\r\n  + if (round(height) < lowest) lowest = round(height);\r\n\r\n` },
  { afterMs: 2000, text: `${DIM}run${RESET} npm test -- tide-tables\r\n` },
  { afterMs: 2400, text: `  ${BOLD}PASS${RESET} 41 tests\r\n\r\n` },
  { afterMs: 1500, text: `Fixed. Commit this? ${BOLD}(y/n)${RESET} `, bell: true },
];

const AGENT_DONE = `\r\n\r\n${DIM}run${RESET} git commit -m "Round tide heights before comparing"\r\n  [main 4f2c9e1] 1 file changed, 1 insertion(+), 1 deletion(-)\r\n\r\nDone. This is a recording, by the way: on your own glasses,\r\nthis would be your real terminal, on your real computer.\r\n\r\n> `;

const BUILD_LINES = ["compiled client", "compiled server", "bundled 214 modules", "typecheck: no errors", "rebuilt in 840 ms"];

export type DemoTerminalListener = { onBell(at: number): void; onOutput(text: string, at: number): void; onTitle(title: string): void };

export class DemoTerminalSession {
  private screen = "";
  private lastBellAt: number | null = null;
  private lastOutputAt: number | null = null;
  private readonly listeners = new Set<DemoTerminalListener>();

  constructor(
    readonly socket: string,
    readonly command: string,
    private readonly cwd: string,
    private title: string,
    private readonly onInput: (session: DemoTerminalSession, text: string) => void,
  ) {}

  describe() {
    return { socket: this.socket, pid: 4100 + this.socket.length, cwdHint: this.cwd, lastBellAt: this.lastBellAt, lastOutputAt: this.lastOutputAt, title: this.title };
  }

  subscribe(listener: DemoTerminalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  screenText(): string { return this.screen; }

  input(text: string): void { this.onInput(this, text); }

  write(text: string): void {
    const at = Date.now();
    this.screen += text;
    this.lastOutputAt = at;
    for (const listener of [...this.listeners]) listener.onOutput(text, at);
  }

  bell(): void {
    const at = Date.now();
    this.lastBellAt = at;
    this.write("\u0007");
    for (const listener of [...this.listeners]) listener.onBell(at);
  }

  setTitle(title: string): void {
    this.title = title;
    for (const listener of [...this.listeners]) listener.onTitle(title);
  }
}

function playScript(session: DemoTerminalSession, steps: Step[], index: number): void {
  const step = steps[index];
  if (!step) return;
  setTimeout(() => {
    session.write(step.text);
    if (step.bell) session.bell();
    playScript(session, steps, index + 1);
  }, step.afterMs);
}

let agentAnswered = false;

function agentInput(session: DemoTerminalSession, text: string): void {
  session.write(text.replace(/\r/g, ""));
  if (!text.includes("\r")) return;
  if (!agentAnswered && /^\s*y/i.test(text)) {
    agentAnswered = true;
    session.write(AGENT_DONE);
    session.setTitle("agent: done");
  } else {
    session.write(`\r\n\r\nI'm only a recording, so I can't do that, sorry.\r\n\r\n> `);
  }
}

function startBuildLoop(session: DemoTerminalSession): void {
  session.write(`${BOLD}$ npm run watch${RESET}\r\n`);
  let line = 0;
  setInterval(() => {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    session.write(`${DIM}${time}${RESET} ${BUILD_LINES[line++ % BUILD_LINES.length]}\r\n`);
  }, 2500);
}

let sessions: DemoTerminalSession[] | null = null;
let launched = 0;

export function demoTerminalSessions(): DemoTerminalSession[] {
  if (!sessions) {
    const agent = new DemoTerminalSession("demo-agent", "agent", "~/projects/tide-tables", "agent: tide-tables", agentInput);
    const build = new DemoTerminalSession("demo-build", "npm run watch", "~/projects/site", "npm run watch", (session, text) => {
      if (text.includes("\u0003")) session.write("^C\r\n");
    });
    sessions = [agent, build];
    playScript(agent, AGENT_SCRIPT, 0);
    startBuildLoop(build);
  }
  return sessions;
}

export function launchDemoTerminalSession(preset: string): DemoTerminalSession {
  const session = new DemoTerminalSession(`demo-${++launched}`, preset, "~", preset, (self, text) => {
    self.write(text.replace(/\r/g, "\r\n"));
  });
  demoTerminalSessions().push(session);
  session.write(`$ ${preset}\r\nThis is a recording, so there's no real ${preset} here.\r\n`);
  return session;
}
