import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("process");

export interface ProcessManagerEvents {
  message: [data: string];
  error: [error: Error];
  exit: [code: number | null, signal: string | null];
}

export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private process: ChildProcess | null = null;
  private stdoutReader: Interface | null = null;
  private command: string;
  private args: string[];

  constructor(command: string, args: string[] = []) {
    super();
    this.command = command;
    this.args = args;
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  spawn(): void {
    if (this.isRunning) {
      log.warn("Process already running, not spawning new one");
      return;
    }

    log.info({ command: this.command, args: this.args }, "Spawning process");

    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure claude-code-acp gets the API key
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
    });

    if (!this.process.stdout || !this.process.stdin || !this.process.stderr) {
      const err = new Error("Failed to establish stdio pipes");
      log.error(err, "Spawn failed");
      this.emit("error", err);
      return;
    }

    log.info({ pid: this.process.pid }, "Process spawned");

    // Read stdout line by line (NDJSON)
    this.stdoutReader = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.stdoutReader.on("line", (line) => {
      if (line.trim()) {
        log.debug({ direction: "out", message: line }, "Process stdout");
        this.emit("message", line);
      }
    });

    // Log stderr
    this.process.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        log.info({ stderr: text }, "Process stderr");
      }
    });

    this.process.on("error", (err) => {
      log.error(err, "Process error");
      this.emit("error", err);
    });

    this.process.on("exit", (code, signal) => {
      log.info({ code, signal }, "Process exited");
      this.cleanup();
      this.emit("exit", code, signal);
    });
  }

  send(message: string): boolean {
    if (!this.isRunning || !this.process?.stdin) {
      log.warn("Cannot send message, process not running");
      return false;
    }

    log.debug({ direction: "in", message }, "Sending to process");

    // NDJSON: each message is a line
    const line = message.endsWith("\n") ? message : message + "\n";
    return this.process.stdin.write(line);
  }

  kill(): void {
    if (this.process) {
      log.info({ pid: this.process.pid }, "Killing process");
      this.process.kill("SIGTERM");

      // Force kill after timeout
      setTimeout(() => {
        if (this.process && this.process.exitCode === null) {
          log.warn("Process did not exit, sending SIGKILL");
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }
  }

  private cleanup(): void {
    if (this.stdoutReader) {
      this.stdoutReader.close();
      this.stdoutReader = null;
    }
    this.process = null;
  }
}
