import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { EnvironmentProcessClosure } from "./environment-channel.js";

// A PID tree is not an ownership boundary on Windows: children survive their
// parent and its PID can be reused. The supervisor owns a kill-on-close Job
// Object, assigns the process atomically at creation before application code runs,
// and acknowledges cleanup only once the kernel reports zero active processes.
export async function spawnWindowsOwnedProcess(input: {
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  signal: AbortSignal;
}): Promise<{
  child: ChildProcessWithoutNullStreams;
  closed: Promise<EnvironmentProcessClosure>;
  close: (timeoutMilliseconds: number) => Promise<void>;
}> {
  const commandLine = [input.executable, ...input.arguments]
    .map(quoteWindowsArgument)
    .join(" ");
  if (
    commandLine.length >= 32_767 ||
    Object.keys(input.environment).some(
      (key) => !key || key.includes("=") || key.includes("\0"),
    ) ||
    [
      input.executable,
      ...input.arguments,
      input.cwd,
      ...Object.values(input.environment),
    ].some((value) => value.includes("\0"))
  ) {
    throw new Error("windows_job_launch_input_invalid");
  }
  // Like Node's Windows spawn, retain SystemRoot when callers supply a minimal
  // environment. Windows cryptographic initialization requires it.
  const launchEnvironment = { ...input.environment };
  if (
    !Object.keys(launchEnvironment).some(
      (key) => key.toUpperCase() === "SYSTEMROOT",
    )
  ) {
    launchEnvironment.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  }
  // Sorted keys, first spelling wins when keys differ only in case.
  const environmentKeys = new Set<string>();
  const environment =
    Object.keys(launchEnvironment)
      .sort()
      .filter((key) => {
        const normalized = key.toUpperCase();
        if (environmentKeys.has(normalized)) return false;
        environmentKeys.add(normalized);
        return true;
      })
      // CreateProcess additionally requires the final block in case-insensitive
      // Unicode order. Deduplicate first so Node's spelling precedence holds.
      .sort((left, right) => {
        const a = left.toUpperCase();
        const b = right.toUpperCase();
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .map((key) => `${key}=${launchEnvironment[key]}`)
      .join("\0") + "\0\0";
  const configuration =
    [input.executable, commandLine, input.cwd, environment]
      .map((value) => Buffer.from(value, "utf8").toString("base64"))
      .join("\n") + "\n";
  if (Buffer.byteLength(configuration, "utf8") > 4_000_000)
    throw new Error("windows_job_launch_input_too_large");
  const secret = randomBytes(32).toString("hex");
  const server = createServer();
  server.maxConnections = 8;
  const connections = new Set<Socket>();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("windows_job_control_unavailable");
  let control: Socket | undefined;
  let controlClosed: Promise<void> | undefined;
  let authenticated = false;
  let cleaned = false;
  let ownershipReady = false;
  let protocolFailed = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    if (control) {
      socket.destroy();
      return;
    }
    let buffer = "";
    let receivedBytes = 0;
    const invalid = () => {
      if (socket === control) {
        protocolFailed = true;
        readyReject(new Error("windows_job_control_protocol_invalid"));
      }
      socket.destroy();
    };
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      buffer += chunk.toString("ascii");
      if (receivedBytes > 256) {
        invalid();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!authenticated) {
          if (line !== secret || control) {
            socket.destroy();
            return;
          }
          authenticated = true;
          control = socket;
          controlClosed = new Promise<void>((resolve) =>
            socket.once("close", resolve),
          );
          for (const other of connections)
            if (other !== socket) other.destroy();
          socket.setTimeout(0);
          socket.write(configuration);
          server.close();
        } else if (
          socket === control &&
          line === "ready" &&
          !ownershipReady &&
          !cleaned
        ) {
          ownershipReady = true;
          readyResolve();
        } else if (
          socket === control &&
          line === "clean" &&
          ownershipReady &&
          !cleaned
        )
          cleaned = true;
        else invalid();
      }
    });
  });
  const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\nAdd-Type -TypeDefinition @'\n${WINDOWS_JOB_SOURCE}\n'@\n$c = $env:SEDES_WINDOWS_JOB_CONTROL.Split(':')\nexit ([SedesOwnedProcess]::Run([int]$c[0], $c[1]))`;
  const child = spawn(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SEDES_WINDOWS_JOB_CONTROL: `${address.port}:${secret}`,
      },
    },
  ) as ChildProcessWithoutNullStreams;
  const closed = new Promise<EnvironmentProcessClosure>((resolve) => {
    child.once("error", (cause) => {
      readyReject(new Error("windows_job_supervisor_spawn_failed", { cause }));
      resolve({ reason: "spawn_error", exitCode: null, signal: null, cause });
    });
    // The independent control socket can deliver its final receipt after the
    // process close event. Drain it before publishing the closure.
    child.once("close", async (exitCode, signal) => {
      readyReject(new Error("windows_job_supervisor_closed_before_ready"));
      await controlClosed;
      resolve({ reason: "exit", exitCode, signal });
      for (const connection of connections) connection.destroy();
      server.close();
    });
  });
  const abort = () => {
    readyReject(input.signal.reason);
    control?.end();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => readyReject(new Error("windows_job_start_deadline_exceeded")),
    30_000,
  );
  try {
    if (input.signal.aborted) abort();
    await ready;
    if (protocolFailed) throw new Error("windows_job_control_protocol_invalid");
  } catch (error) {
    server.close();
    if (control) {
      // Configuration has crossed the boundary: a root may already exist.
      // Closing stdin on the control connection asks the supervisor to prove
      // the job empty before admission failure releases the caller's lease.
      control.end();
      try {
        await waitForClosure(closed, 5_000);
        if (!cleaned || protocolFailed)
          throw new Error("windows_job_cleanup_unconfirmed");
      } catch (cleanupError) {
        child.kill();
        for (const connection of connections) connection.destroy();
        throw new Error("windows_job_open_cleanup_unconfirmed", {
          cause: new AggregateError([error, cleanupError]),
        });
      }
    } else {
      // No configuration was supplied, so no application process can exist.
      for (const connection of connections) connection.destroy();
      child.kill();
      await waitForClosure(closed, 5_000);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
  }
  return {
    child,
    closed,
    async close(timeoutMilliseconds) {
      control?.end();
      try {
        await waitForClosure(closed, timeoutMilliseconds);
        if (!cleaned || protocolFailed)
          throw new Error("windows_job_cleanup_unconfirmed");
      } catch (error) {
        // Last resort closes the job handle in the supervisor, but cannot
        // manufacture a verified empty-job receipt. Preserve the failure.
        child.kill();
        control?.destroy();
        throw error;
      }
    },
  };
}

async function waitForClosure(
  closed: Promise<EnvironmentProcessClosure>,
  timeoutMilliseconds: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("windows_job_close_deadline_exceeded")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Windows CreateProcess/C runtime quoting; no shell ever interprets these.
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Net.Sockets;
using System.Threading;
public static class SedesOwnedProcess {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long a,b; public uint LimitFlags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr a,b,c,d; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint e,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string reserved,desktop,title; public uint x,y,xsize,ysize,xcount,ycount,fill,flags; public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out ACCOUNTING info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Send(NetworkStream stream, string message) { byte[] bytes=Encoding.ASCII.GetBytes(message+"\n"); stream.Write(bytes,0,bytes.Length); stream.Flush(); }
  static string ReadConfiguration(NetworkStream stream) {
    StringBuilder line=new StringBuilder(); int value;
    while ((value=stream.ReadByte())!=10) { if(value<0 || line.Length>4000000) throw new Exception("Invalid launch configuration"); line.Append((char)value); }
    return Encoding.UTF8.GetString(Convert.FromBase64String(line.ToString()));
  }
  public static int Run(int port, string secret) {
    IntPtr job=IntPtr.Zero, env=IntPtr.Zero, attributes=IntPtr.Zero, handles=IntPtr.Zero, jobs=IntPtr.Zero;
    bool attributesInitialized=false;
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    using (TcpClient control=new TcpClient("127.0.0.1",port)) {
      NetworkStream stream=control.GetStream();
      Send(stream,secret);
      string executable=ReadConfiguration(stream), command=ReadConfiguration(stream), cwd=ReadConfiguration(stream), environment=ReadConfiguration(stream);
      try {
        job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
        EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags=0x2000;
        Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
        STARTUPINFOEX si=new STARTUPINFOEX(); si.startup.cb=(uint)Marshal.SizeOf(si); si.startup.flags=0x100;
        si.startup.input=GetStdHandle(-10); si.startup.output=GetStdHandle(-11); si.startup.error=GetStdHandle(-12);
        Check(SetHandleInformation(si.startup.input,1,1)); Check(SetHandleInformation(si.startup.output,1,1)); Check(SetHandleInformation(si.startup.error,1,1));
        IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
        attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,2,0,ref size)); attributesInitialized=true;
        jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
        handles=Marshal.AllocHGlobal(3*IntPtr.Size); Marshal.WriteIntPtr(handles,0,si.startup.input); Marshal.WriteIntPtr(handles,IntPtr.Size,si.startup.output); Marshal.WriteIntPtr(handles,2*IntPtr.Size,si.startup.error);
        // JOB_LIST establishes ownership atomically with process creation;
        // HANDLE_LIST excludes the job and control socket from inheritance.
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        si.attributes=attributes;
        env=Marshal.StringToHGlobalUni(environment);
        Check(CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08080400,env,cwd,ref si,out pi));
        Send(stream,"ready");
        using (ManualResetEvent stopped=new ManualResetEvent(false)) {
          Thread reader=new Thread(delegate() { try { stream.ReadByte(); } catch {} finally { try { stopped.Set(); } catch (ObjectDisposedException) {} } });
          reader.IsBackground=true; reader.Start();
          while (WaitForSingleObject(pi.process,10)==0x102 && !stopped.WaitOne(0)) {}
          uint code; Check(GetExitCodeProcess(pi.process,out code));
          Check(TerminateJobObject(job,code==259 ? 1u : code));
          ACCOUNTING accounting;
          do { Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)); if (accounting.ActiveProcesses!=0) Thread.Sleep(1); } while(accounting.ActiveProcesses!=0);
          Send(stream,"clean");
          return unchecked((int)(code==259 ? 1u : code));
        }
      } finally {
        if(attributesInitialized) DeleteProcThreadAttributeList(attributes);
        if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
        if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
        if(job!=IntPtr.Zero) CloseHandle(job);
        if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
        if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
        if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
      }
    }
  }
}`;
