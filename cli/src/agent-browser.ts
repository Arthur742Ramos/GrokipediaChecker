import { execSync } from "child_process";

export function abOpen(url: string, session?: string): string {
  const cmd = session ? `agent-browser --session ${session} open "${url}"` : `agent-browser open "${url}"`;
  return execSync(cmd, { encoding: "utf-8" });
}

export function abSnapshot(session?: string, interactive = true, compact = true): string {
  const flags = [interactive ? "-i" : "", compact ? "-c" : ""].filter(Boolean).join(" ");
  const cmd = session ? `agent-browser --session ${session} snapshot ${flags}` : `agent-browser snapshot ${flags}`;
  return execSync(cmd, { encoding: "utf-8" });
}

export function abClick(ref: string, session?: string): string {
  const cmd = session ? `agent-browser --session ${session} click ${ref}` : `agent-browser click ${ref}`;
  return execSync(cmd, { encoding: "utf-8" });
}

export function abFill(ref: string, text: string, session?: string): string {
  const escaped = text.replace(/"/g, '\\"');
  const cmd = session ? `agent-browser --session ${session} fill ${ref} "${escaped}"` : `agent-browser fill ${ref} "${escaped}"`;
  return execSync(cmd, { encoding: "utf-8" });
}

export function abEval(js: string, session?: string): string {
  const escaped = js.replace(/"/g, '\\"');
  const cmd = session ? `agent-browser --session ${session} eval "${escaped}"` : `agent-browser eval "${escaped}"`;
  return execSync(cmd, { encoding: "utf-8" });
}

export function abClose(session?: string): void {
  const cmd = session ? `agent-browser --session ${session} close` : `agent-browser close`;
  try { execSync(cmd); } catch {}
}

export function abWait(ms: number, session?: string): void {
  const cmd = session ? `agent-browser --session ${session} wait ${ms}` : `agent-browser wait ${ms}`;
  execSync(cmd);
}

export function findRefByText(snapshot: string, text: string): string | null {
  const lower = text.toLowerCase();
  for (const line of snapshot.split("\n")) {
    if (line.toLowerCase().includes(lower)) {
      const match = line.match(/\[ref=(e\d+)\]/);
      if (match) return match[1];
    }
  }
  return null;
}
