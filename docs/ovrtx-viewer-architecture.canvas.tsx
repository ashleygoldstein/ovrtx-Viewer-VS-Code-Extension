import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Grid,
  H1,
  H2,
  Pill,
  Row,
  Stack,
  Stat,
  Text,
  computeDAGLayout,
  useCanvasAction,
  useHostTheme,
  useState,
} from "cursor/canvas";

type NodeInfo = {
  id: string;
  title: string;
  subtitle: string;
  file: string;
  line?: number;
  layer: "VS Code" | "Python" | "Browser" | "Session";
  detail: string;
};

type EdgeInfo = {
  from: string;
  to: string;
  label: string;
};

type View = {
  id: string;
  label: string;
  summary: string;
  nodes: NodeInfo[];
  edges: EdgeInfo[];
};

const views: View[] = [
  {
    id: "system",
    label: "System map",
    summary: "The extension launches a preparation process, discovers the runtime through session files, and embeds the loopback viewer through VS Code port forwarding.",
    nodes: [
      { id: "manifest", title: "Extension manifest", subtitle: "commands + settings", file: "package.json", line: 1, layer: "VS Code", detail: "Declares the extension entry point, Open/Stop commands, USD context menus, Python paths, GPU index, and preferred port." },
      { id: "host", title: "Extension host", subtitle: "open / stop lifecycle", file: "extension.js", line: 53, layer: "VS Code", detail: "Validates the USD file and workspace trust, discovers Python, creates a session, starts a VS Code task, and owns shutdown." },
      { id: "launch", title: "Runtime launcher", subtitle: "two Python environments", file: "runtime/launch.py", line: 9, layer: "Python", detail: "Runs scene preparation with a Python that has OpenUSD, then hands execution to the configured OVRTX runtime Python." },
      { id: "prepare", title: "USD preparation", subtitle: "overlay + framing", file: "runtime/prepare.py", line: 8, layer: "Python", detail: "Computes scene bounds and writes a non-destructive USD overlay containing the viewer camera, render product, and optional fill light." },
      { id: "files", title: "Session directory", subtitle: "viewer.usda + JSON", file: "runtime/prepare.py", line: 31, layer: "Session", detail: "Per-open storage holds viewer.usda, scene.json, connection.json, overview.png, and ovrtx.log." },
      { id: "server", title: "Loopback server", subtitle: "HTTP + render owner", file: "runtime/server.py", line: 94, layer: "Python", detail: "Binds only to 127.0.0.1, gates routes by a random session capability, serves static UI, and serializes all GPU calls on one thread." },
      { id: "renderer", title: "OVRTX renderer", subtitle: "GPU scene + pixels", file: "runtime/renderer.py", line: 6, layer: "Python", detail: "Loads viewer.usda through OVStage, updates the camera transform, steps OVRTX, and converts GPU output to a Pillow image." },
      { id: "bridge", title: "Startup bridge", subtitle: "connection + health", file: "session.js", line: 29, layer: "VS Code", detail: "Polls connection.json, verifies the session at /health, and rejects stale or unrelated services on the selected port." },
      { id: "panel", title: "VS Code webview", subtitle: "sandboxed iframe", file: "extension.js", line: 9, layer: "VS Code", detail: "Uses asExternalUri for local or remote port forwarding, then hosts the viewer in a CSP-restricted iframe." },
      { id: "browser", title: "Viewer UI", subtitle: "camera input + JPEG", file: "runtime/web/viewer.js", line: 12, layer: "Browser", detail: "Turns pointer, wheel, keyboard, and preset input into camera parameters, requests a frame, and swaps the returned JPEG blob." },
    ],
    edges: [
      { from: "manifest", to: "host", label: "activates" },
      { from: "host", to: "launch", label: "VS Code task" },
      { from: "launch", to: "prepare", label: "prepare()" },
      { from: "prepare", to: "files", label: "writes" },
      { from: "launch", to: "server", label: "exec / subprocess" },
      { from: "files", to: "server", label: "scene inputs" },
      { from: "server", to: "renderer", label: "render()" },
      { from: "host", to: "bridge", label: "waits" },
      { from: "bridge", to: "server", label: "GET /health" },
      { from: "bridge", to: "panel", label: "ready port" },
      { from: "panel", to: "browser", label: "iframe" },
      { from: "browser", to: "server", label: "GET scene / frame" },
    ],
  },
  {
    id: "startup",
    label: "Open sequence",
    summary: "Opening a USD file is a staged handshake: validation, preprocessing, GPU warmup, capability publication, health verification, then iframe reveal.",
    nodes: [
      { id: "command", title: "Open command", subtitle: "validate input", file: "extension.js", line: 53, layer: "VS Code", detail: "Checks workspace trust, URI scheme, USD extension, settings, and Python executable paths." },
      { id: "task", title: "VS Code task", subtitle: "launch.py", file: "extension.js", line: 77, layer: "VS Code", detail: "Creates a dedicated ProcessExecution task so progress and errors remain visible in the task terminal." },
      { id: "prep", title: "Prepare scene", subtitle: "OpenUSD CPU work", file: "runtime/prepare.py", line: 8, layer: "Python", detail: "Frames visible geometry and composes the source under a temporary viewer overlay without modifying the source." },
      { id: "warm", title: "Warm renderer", subtitle: "OVRTX shader startup", file: "runtime/server.py", line: 108, layer: "Python", detail: "Loads the prepared scene, renders an overview image, and only then advertises readiness." },
      { id: "publish", title: "Publish capability", subtitle: "connection.json", file: "runtime/server.py", line: 37, layer: "Session", detail: "Atomically publishes protocol, session ID, ready state, and the actual bound port." },
      { id: "health", title: "Verify health", subtitle: "session.js polling", file: "session.js", line: 43, layer: "VS Code", detail: "Reads connection metadata and verifies service, protocol, readiness, and exact session over HTTP." },
      { id: "forward", title: "Forward address", subtitle: "asExternalUri", file: "extension.js", line: 88, layer: "VS Code", detail: "Lets VS Code translate loopback into a reachable URL, including remote and SSH workspaces." },
      { id: "ready", title: "Interactive viewer", subtitle: "iframe revealed", file: "runtime/web/viewer.js", line: 99, layer: "Browser", detail: "Loads scene metadata and requests the initial camera frame." },
    ],
    edges: [
      { from: "command", to: "task", label: "executeTask" },
      { from: "task", to: "prep", label: "Python #1" },
      { from: "prep", to: "warm", label: "Python #2" },
      { from: "warm", to: "publish", label: "ready" },
      { from: "publish", to: "health", label: "poll + GET" },
      { from: "health", to: "forward", label: "verified port" },
      { from: "forward", to: "ready", label: "iframe URL" },
    ],
  },
  {
    id: "frame",
    label: "Frame request",
    summary: "Each camera interaction causes a complete server-side render. The browser receives compressed pixels, not scene geometry.",
    nodes: [
      { id: "input", title: "Camera input", subtitle: "orbit / pan / zoom", file: "runtime/web/viewer.js", line: 41, layer: "Browser", detail: "Updates yaw, elevation, zoom, and pan. Wheel and keyboard changes debounce for 60 ms; dragging requests immediately." },
      { id: "request", title: "HTTP request", subtitle: "GET /frame?…", file: "runtime/web/viewer.js", line: 12, layer: "Browser", detail: "Sends camera state as query parameters while preserving VS Code's forwarded URL prefix." },
      { id: "gate", title: "Session gate", subtitle: "capability path", file: "runtime/server.py", line: 50, layer: "Python", detail: "Constant-time compares the random path segment and returns 404 for the wrong session." },
      { id: "camera", title: "Camera validation", subtitle: "query → matrix", file: "runtime/camera.py", line: 9, layer: "Python", detail: "Checks parameter cardinality, numeric values, and limits before producing the camera transform." },
      { id: "gpu", title: "GPU render", subtitle: "OVStage + OVRTX", file: "runtime/renderer.py", line: 31, layer: "Python", detail: "Writes the camera transform, advances the renderer up to ten steps, and skips incomplete early frames." },
      { id: "encode", title: "JPEG encode", subtitle: "quality 90", file: "runtime/server.py", line: 58, layer: "Python", detail: "Moves pixels through DLPack and NumPy into Pillow, then encodes an in-memory JPEG response." },
      { id: "display", title: "Image swap", subtitle: "blob object URL", file: "runtime/web/viewer.js", line: 20, layer: "Browser", detail: "Installs the new object URL on the image and revokes the old one to avoid leaking browser memory." },
    ],
    edges: [
      { from: "input", to: "request", label: "schedule / refresh" },
      { from: "request", to: "gate", label: "loopback HTTP" },
      { from: "gate", to: "camera", label: "authorized query" },
      { from: "camera", to: "gpu", label: "camera matrix" },
      { from: "gpu", to: "encode", label: "RGB pixels" },
      { from: "encode", to: "display", label: "image/jpeg" },
    ],
  },
];

const layerOrder = ["VS Code", "Python", "Session", "Browser"] as const;

function ArchitectureGraph({ view, selected, onSelect }: {
  view: View;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const theme = useHostTheme();
  const nodeWidth = 172;
  const nodeHeight = 68;
  const layout = computeDAGLayout({
    nodes: view.nodes.map(({ id }) => ({ id })),
    edges: view.edges.map(({ from, to }) => ({ from, to })),
    direction: "horizontal",
    nodeWidth,
    nodeHeight,
    rankGap: 92,
    nodeGap: 28,
    padding: 30,
  });
  const byId = Object.fromEntries(view.nodes.map(node => [node.id, node]));
  const layerColors: Record<NodeInfo["layer"], string> = {
    "VS Code": theme.accent.primary,
    Python: theme.chart.sequence[1] || theme.text.link,
    Session: theme.chart.sequence[2] || theme.text.secondary,
    Browser: theme.chart.sequence[3] || theme.text.tertiary,
  };
  const width = Math.max(920, layout.width);
  const height = Math.max(280, layout.height);

  return (
    <div style={{ overflowX: "auto", border: `1px solid ${theme.stroke.tertiary}`, borderRadius: theme.radius.md, background: theme.bg.editor }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", minWidth: 920, height: "auto" }} role="img" aria-label={`${view.label} directed architecture graph`}>
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill={theme.stroke.primary} />
          </marker>
          <marker id="arrowBack" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill={theme.text.tertiary} />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => {
          const spec = view.edges.find(item => item.from === edge.from && item.to === edge.to);
          const midX = (edge.sourceX + edge.targetX) / 2;
          const midY = (edge.sourceY + edge.targetY) / 2;
          const bend = edge.isBackEdge ? -34 : 0;
          return (
            <g key={`${edge.from}-${edge.to}-${index}`}>
              <path
                d={`M ${edge.sourceX} ${edge.sourceY} C ${midX} ${edge.sourceY + bend}, ${midX} ${edge.targetY + bend}, ${edge.targetX} ${edge.targetY}`}
                fill="none"
                stroke={edge.isBackEdge ? theme.text.tertiary : theme.stroke.primary}
                strokeWidth={1.5}
                strokeDasharray={edge.isBackEdge ? "5 4" : undefined}
                markerEnd={edge.isBackEdge ? "url(#arrowBack)" : "url(#arrow)"}
              />
              {spec?.label && (
                <g>
                  <rect x={midX - 43} y={midY + bend - 10} width={86} height={19} rx={5} fill={theme.bg.editor} />
                  <text x={midX} y={midY + bend + 3} textAnchor="middle" fontSize={10} fill={theme.text.tertiary}>{spec.label}</text>
                </g>
              )}
            </g>
          );
        })}
        {layout.nodes.map(position => {
          const node = byId[position.id];
          const active = selected === node.id;
          return (
            <g key={node.id} onClick={() => onSelect(node.id)} style={{ cursor: "pointer" }} role="button" aria-label={`Inspect ${node.title}`}>
              <rect
                x={position.x}
                y={position.y}
                width={nodeWidth}
                height={nodeHeight}
                rx={theme.radius.md}
                fill={active ? theme.fill.secondary : theme.bg.elevated}
                stroke={active ? theme.accent.primary : theme.stroke.secondary}
                strokeWidth={active ? 2 : 1}
              />
              <rect x={position.x} y={position.y} width={5} height={nodeHeight} rx={2.5} fill={layerColors[node.layer]} />
              <text x={position.x + 16} y={position.y + 27} fontSize={13} fontWeight={600} fill={theme.text.primary}>{node.title}</text>
              <text x={position.x + 16} y={position.y + 48} fontSize={11} fill={theme.text.secondary}>{node.subtitle}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function OVRTXArchitecture() {
  const theme = useHostTheme();
  const dispatch = useCanvasAction();
  const [viewId, setViewId] = useState("system");
  const view = views.find(item => item.id === viewId) || views[0];
  const [selectedByView, setSelectedByView] = useState<Record<string, string>>({
    system: "server",
    startup: "warm",
    frame: "gpu",
  });
  const selectedId = selectedByView[view.id] || view.nodes[0].id;
  const selected = view.nodes.find(node => node.id === selectedId) || view.nodes[0];

  const selectView = (id: string) => {
    setViewId(id);
    if (!selectedByView[id]) {
      const target = views.find(item => item.id === id);
      if (target) setSelectedByView(current => ({ ...current, [id]: target.nodes[0].id }));
    }
  };

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1500, margin: "0 auto", background: theme.bg.editor, minHeight: "100vh" }}>
      <Row justify="space-between" align="end" wrap gap={18}>
        <Stack gap={6} style={{ maxWidth: 820 }}>
          <Text size="small" tone="tertiary" weight="semibold">REPOSITORY ARCHITECTURE</Text>
          <H1>How OVRTX Viewer works</H1>
          <Text tone="secondary">A VS Code workspace extension that preprocesses USD, renders it on the GPU host, and streams each interactive view back as a JPEG.</Text>
        </Stack>
        <Row gap={18}>
          <Stat value="3" label="runtime layers" />
          <Stat value="4" label="HTTP routes" />
          <Stat value="1" label="GPU/render thread" />
        </Row>
      </Row>

      <Callout tone="info" title="Core architectural fact">
        The browser is a camera controller and image viewer. It does not receive USD geometry: every interaction calls <Code>GET /frame</Code>, invokes a server-side OVRTX render, and returns <Code>image/jpeg</Code>. There is no WebSocket.
      </Callout>

      <Row gap={8} wrap>
        {views.map(item => (
          <Pill key={item.id} active={item.id === view.id} onClick={() => selectView(item.id)}>
            {item.label}
          </Pill>
        ))}
      </Row>

      <Text tone="secondary">{view.summary}</Text>

      <Grid columns="minmax(0, 1fr) 300px" gap={16} align="start">
        <Stack gap={12}>
          <ArchitectureGraph
            view={view}
            selected={selected.id}
            onSelect={id => setSelectedByView(current => ({ ...current, [view.id]: id }))}
          />
          <Row gap={14} wrap>
            {layerOrder.map(layer => {
              const visible = view.nodes.some(node => node.layer === layer);
              if (!visible) return null;
              return (
                <Row key={layer} gap={6} align="center">
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: layer === "VS Code" ? theme.accent.primary : theme.chart.sequence[layerOrder.indexOf(layer)] || theme.text.tertiary }} />
                  <Text as="span" size="small" tone="tertiary">{layer}</Text>
                </Row>
              );
            })}
            <Text as="span" size="small" tone="quaternary">Select a node for details</Text>
          </Row>
        </Stack>

        <Card>
          <CardHeader trailing={<Pill size="sm">{selected.layer}</Pill>}>{selected.title}</CardHeader>
          <CardBody>
            <Stack gap={12}>
              <Text>{selected.detail}</Text>
              <Text size="small" tone="secondary"><Code>{selected.file}{selected.line ? `:${selected.line}` : ""}</Code></Text>
              <Button
                variant="secondary"
                onClick={() => dispatch({
                  type: "openFile",
                  path: selected.file,
                  selection: selected.line ? { startLineNumber: selected.line, startColumn: 1, endLineNumber: selected.line, endColumn: 1 } : undefined,
                })}
              >
                Open source
              </Button>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <H2>Lifecycle and boundaries</H2>
      <Grid columns={3} gap={16}>
        <Stack gap={6}>
          <Text weight="semibold">One active session</Text>
          <Text size="small" tone="secondary">Opening a new scene terminates the previous task. Closing the panel, running Stop, or deactivating the extension also terminates it.</Text>
        </Stack>
        <Stack gap={6}>
          <Text weight="semibold">Two Python roles</Text>
          <Text size="small" tone="secondary"><Code>pythonPath</Code> needs OpenUSD for preparation; <Code>runtimePythonPath</Code> needs OVRTX, OVStage, NumPy, and Pillow for rendering.</Text>
        </Stack>
        <Stack gap={6}>
          <Text weight="semibold">Capability-scoped loopback</Text>
          <Text size="small" tone="secondary">The HTTP server binds to <Code>127.0.0.1</Code> and requires the random session ID in every route. VS Code handles remote forwarding.</Text>
        </Stack>
      </Grid>
    </Stack>
  );
}
