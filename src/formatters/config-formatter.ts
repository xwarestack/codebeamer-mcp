import type { CbReference, CbRoleWithPermissions } from "../client/codebeamer-client.js";
import {
  countDifferences,
  describeReference,
  type NormalizedField,
  type NormalizedTracker,
  type TrackerDiff,
  type TrackerEdge,
  type ValueChange,
} from "../analysis/tracker-config.js";
import { cell } from "./item-formatter.js";

const yes = (value: boolean) => (value ? "yes" : "");

function mermaidLabel(text: string): string {
  return text.replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

export function formatWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return ["", "### Not available", "", ...warnings.map((w) => `- ${w}`)].join("\n");
}

function fieldNotes(f: NormalizedField): string {
  const notes: string[] = [];
  if (f.formula) notes.push(`computed: \`${f.formula}\``);
  if (f.mandatoryIf) notes.push(`mandatory if: \`${f.mandatoryIf}\``);
  if (f.mandatoryExceptIn.length > 0) notes.push(`not mandatory in: ${f.mandatoryExceptIn.join(", ")}`);
  if (f.hideIf) notes.push(`hidden if: \`${f.hideIf}\``);
  if (f.dependsOn) {
    notes.push(`depends on: ${f.dependsOn}${f.dependencyValues ? ` (${f.dependencyValues})` : ""}`);
  }
  if (f.options && !f.isStatus) notes.push(`${f.options.length} options`);
  if (f.references && f.references.length > 0) notes.push(`refs: ${f.references.map(describeReference).join("; ")}`);
  return notes.join("; ");
}

export function formatTrackerConfiguration(
  t: NormalizedTracker,
  options: { includeOptions: boolean },
): string {
  const lines = [
    `## Tracker configuration: ${t.name} [${t.id}]`,
    "",
    `- **Key:** ${t.key ?? "-"}`,
    `- **Type:** ${t.typeName ?? (t.basic.issueTypeId !== undefined ? `type ID ${t.basic.issueTypeId}` : "-")}`,
    `- **Project:** ${t.projectName ?? "-"} (ID: ${t.projectId ?? "?"})`,
    `- **Is template:** ${t.template ? "yes" : "no"}`,
    `- **Derived from template tracker:** ${t.templateId ?? "none"}`,
    `- **Workflow active:** ${t.workflowActive === undefined ? "-" : t.workflowActive ? "yes" : "no"}`,
  ];

  const shown = new Set(["name", "key", "trackerId", "projectId", "issueTypeId", "template", "templateId", "workflowIsActive", "description"]);
  const otherSettings = Object.entries(t.basic).filter(
    ([k, v]) => !shown.has(k) && v !== undefined && v !== null && typeof v !== "object",
  );
  if (otherSettings.length > 0) {
    lines.push("", "### Settings", "", otherSettings.map(([k, v]) => `${k}=${String(v)}`).join(" · "));
  }

  lines.push(
    "",
    `### Fields (${t.fields.length})`,
    "",
    "| ID | Name | Type | Mandatory | Hidden | Multiple | Permission | Notes |",
    "|----|------|------|-----------|--------|----------|------------|-------|",
    ...t.fields.map(
      (f) =>
        `| ${f.id ?? "-"} | ${cell(f.name)} | ${cell(f.type)} | ${yes(f.mandatory)} | ${yes(f.hidden)} | ${yes(f.multiple)} | ${cell(f.permission)} | ${cell(fieldNotes(f))} |`,
    ),
  );

  lines.push("", `### Statuses (${t.statuses.length})`, "", t.statuses.map((s) => `${s.name} [${s.id}]`).join(", ") || "_none_");

  if (options.includeOptions) {
    // Statuses are listed here too, since their meanings and restrictions matter for the workflow.
    const choiceFields = t.fields.filter((f) => f.options && f.options.length > 0);
    if (choiceFields.length > 0) {
      lines.push("", "### Choice options");
      for (const f of choiceFields) {
        lines.push("", `**${f.name}** (field ${f.id ?? "?"})`);
        for (const o of f.options!) {
          const extras = [
            o.meanings.length > 0 ? `meanings: ${o.meanings.join(", ")}` : "",
            o.restrictedToStatuses.length > 0 ? `only in: ${o.restrictedToStatuses.join(", ")}` : "",
            o.defaultInStatuses.length > 0 ? `default in: ${o.defaultInStatuses.join(", ")}` : "",
          ].filter(Boolean);
          lines.push(`- [${o.id}] ${o.name}${extras.length > 0 ? ` (${extras.join("; ")})` : ""}`);
        }
      }
    }
  }

  lines.push(formatWarnings(t.warnings));
  return lines.join("\n").trimEnd();
}

export function formatWorkflow(t: NormalizedTracker): string {
  const lines = [
    `## Workflow: ${t.name} [${t.id}]`,
    "",
    `- **Workflow active:** ${t.workflowActive === undefined ? "-" : t.workflowActive ? "yes" : "no"}`,
    `- **Statuses (${t.statuses.length}):** ${t.statuses.map((s) => `${s.name} [${s.id}]`).join(", ") || "none"}`,
  ];

  const transitions = t.transitions ?? [];
  if (transitions.length === 0) {
    lines.push("", "_No transitions returned._", formatWarnings(t.warnings));
    return lines.join("\n").trimEnd();
  }

  lines.push(
    "",
    `### Transitions (${transitions.length})`,
    "",
    "| ID | Name | From | To | Hidden | Allowed for |",
    "|----|------|------|----|--------|-------------|",
    ...transitions.map(
      (tr) =>
        `| ${tr.id} | ${cell(tr.name)} | ${cell(tr.from)} | ${cell(tr.to)} | ${yes(tr.hidden)} | ${cell(tr.allowed.join(", "))} |`,
    ),
  );

  const stateIds = new Map<string, string>();
  const stateId = (name: string) => {
    if (name === "(initial)") return "[*]";
    if (!stateIds.has(name)) stateIds.set(name, `s${stateIds.size}`);
    return stateIds.get(name)!;
  };
  for (const s of t.statuses) stateId(s.name);
  const edges = transitions.map((tr) => `  ${stateId(tr.from)} --> ${stateId(tr.to)}${tr.name ? ` : ${mermaidLabel(tr.name)}` : ""}`);
  lines.push(
    "",
    "### Diagram",
    "",
    "```mermaid",
    "stateDiagram-v2",
    ...[...stateIds.entries()].map(([name, id]) => `  state "${mermaidLabel(name)}" as ${id}`),
    ...edges,
    "```",
  );
  lines.push(formatWarnings(t.warnings));
  return lines.join("\n").trimEnd();
}

export function formatTrackerPermissions(trackerId: number, permissions: CbRoleWithPermissions[]): string {
  if (permissions.length === 0) return `_No role permissions returned for tracker ${trackerId}._`;
  return [
    `## Tracker ${trackerId} permissions by role (${permissions.length} roles)`,
    "",
    "| Role | Permissions |",
    "|------|-------------|",
    ...permissions.map(
      (p) =>
        `| ${cell(p.role?.name ?? `#${p.role?.id ?? "?"}`)} | ${cell((p.trackerPermissions ?? []).map((tp) => tp.name).sort().join(", "))} |`,
    ),
  ].join("\n");
}

export function formatReferenceTable(
  title: string,
  rows: Array<CbReference & { description?: string }>,
  footer?: string,
): string {
  if (rows.length === 0) return `## ${title}\n\n_None found._`;
  const withDescription = rows.some((r) => r.description);
  const lines = [
    `## ${title} (${rows.length})`,
    "",
    withDescription ? "| ID | Name | Description |" : "| ID | Name |",
    withDescription ? "|----|------|-------------|" : "|----|------|",
    ...rows.map((r) =>
      withDescription ? `| ${r.id} | ${cell(r.name)} | ${cell(r.description)} |` : `| ${r.id} | ${cell(r.name)} |`,
    ),
  ];
  if (footer) lines.push("", footer);
  return lines.join("\n");
}

export function formatTrackerGraph(
  title: string,
  trackers: NormalizedTracker[],
  edges: TrackerEdge[],
  warnings: string[],
): string {
  const lines = [`## ${title}`, "", `${trackers.length} trackers, ${edges.length} references to tracker items.`];

  if (edges.length > 0) {
    lines.push(
      "",
      "| From tracker | Reference field | Multiple | Points to |",
      "|--------------|-----------------|----------|-----------|",
      ...edges.map(
        (e) => `| ${cell(e.fromName)} [${e.fromId}] | ${cell(e.field)} | ${yes(e.multiple)} | ${cell(describeReference(e.reference))} |`,
      ),
    );

    const nodeIds = new Map<string, string>();
    const node = (key: string, label: string) => {
      if (!nodeIds.has(key)) nodeIds.set(key, `n${nodeIds.size}["${mermaidLabel(label)}"]`);
      return nodeIds.get(key)!.split("[")[0];
    };
    for (const t of trackers) node(`TRACKER:${t.id}`, t.name);
    // One arrow per tracker pair, labelled with every field that links them, keeps large projects readable.
    const arrows = new Map<string, { from: string; to: string; fields: Set<string> }>();
    for (const e of edges) {
      const ref = e.reference;
      const label = ref.domainName ?? `${ref.domainType.toLowerCase()} ${ref.domainId ?? "?"}`;
      const to = node(
        `${ref.domainType}:${ref.domainId}`,
        ref.ownProject === false && ref.targetProjectName ? `${label} (${ref.targetProjectName})` : label,
      );
      const from = node(`TRACKER:${e.fromId}`, e.fromName);
      const arrow = arrows.get(`${from}>${to}`) ?? { from, to, fields: new Set<string>() };
      arrow.fields.add(e.field);
      arrows.set(`${from}>${to}`, arrow);
    }
    lines.push(
      "",
      "```mermaid",
      "flowchart LR",
      ...[...nodeIds.values()].map((n) => `  ${n}`),
      ...[...arrows.values()].map((a) => `  ${a.from} -->|"${mermaidLabel([...a.fields].join(", "))}"| ${a.to}`),
      "```",
    );
  }

  const isolated = trackers.filter(
    (t) => !edges.some((e) => e.fromId === t.id || (e.reference.domainType === "TRACKER" && e.reference.domainId === t.id)),
  );
  if (isolated.length > 0) {
    lines.push("", `**Trackers without reference fields in or out:** ${isolated.map((t) => `${t.name} [${t.id}]`).join(", ")}`);
  }
  lines.push(formatWarnings(warnings));
  return lines.join("\n").trimEnd();
}

function changeTable(changes: ValueChange[], labelA: string, labelB: string): string[] {
  return [
    `| Property | ${labelA} | ${labelB} |`,
    "|---|---|---|",
    ...changes.map((c) => `| ${cell(c.property)} | ${cell(c.a)} | ${cell(c.b)} |`),
  ];
}

function bulletList(title: string, items: string[]): string[] {
  return items.length > 0 ? ["", `**${title}:**`, ...items.map((i) => `- ${i}`)] : [];
}

export function formatTrackerDiff(
  diff: TrackerDiff,
  labels: { a: string; b: string } = { a: "A", b: "B" },
): string {
  const describe = (side: TrackerDiff["a"]) =>
    `"${side.name}" [${side.id}]${side.projectName ? ` in ${side.projectName}` : ""}`;
  const counts = countDifferences(diff);
  const lines = [
    `## Comparison: ${labels.a} = ${describe(diff.a)} vs ${labels.b} = ${describe(diff.b)}`,
    "",
    counts.total === 0
      ? "**No differences found.**"
      : `**${counts.total} differences:** settings ${counts.settings}, fields ${counts.fields}, statuses ${counts.statuses}, ` +
        `transitions ${diff.transitionsCompared ? counts.transitions : "not compared"}, ` +
        `permissions ${diff.permissions ? counts.permissions : "not compared"}.`,
  ];

  if (diff.settings.length > 0) {
    lines.push("", "### Tracker settings", "", ...changeTable(diff.settings, labels.a, labels.b));
  }

  if (diff.fieldsOnlyInA.length + diff.fieldsOnlyInB.length + diff.fieldChanges.length > 0) {
    lines.push("", "### Fields");
    lines.push(...bulletList(`Only in ${labels.a}`, diff.fieldsOnlyInA));
    lines.push(...bulletList(`Only in ${labels.b}`, diff.fieldsOnlyInB));
    lines.push(...bulletList("Possibly renamed", diff.possibleRenames));
    for (const fc of diff.fieldChanges) {
      lines.push("", `#### ${fc.field}`, "", ...changeTable(fc.changes, labels.a, labels.b));
    }
  }

  if (diff.statusesOnlyInA.length + diff.statusesOnlyInB.length > 0) {
    lines.push("", "### Statuses");
    lines.push(...bulletList(`Only in ${labels.a}`, diff.statusesOnlyInA));
    lines.push(...bulletList(`Only in ${labels.b}`, diff.statusesOnlyInB));
  }

  if (diff.transitionsCompared && counts.transitions > 0) {
    lines.push("", "### Transitions");
    lines.push(...bulletList(`Only in ${labels.a}`, diff.transitionsOnlyInA));
    lines.push(...bulletList(`Only in ${labels.b}`, diff.transitionsOnlyInB));
    for (const tc of diff.transitionChanges) {
      lines.push("", `#### ${tc.transition}`, "", ...changeTable(tc.changes, labels.a, labels.b));
    }
  }

  if (diff.permissions && counts.permissions > 0) {
    lines.push("", "### Role permissions");
    lines.push(...bulletList(`Roles only in ${labels.a}`, diff.permissions.rolesOnlyInA));
    lines.push(...bulletList(`Roles only in ${labels.b}`, diff.permissions.rolesOnlyInB));
    if (diff.permissions.changes.length > 0) {
      lines.push(
        "",
        `| Role | Only in ${labels.a} | Only in ${labels.b} |`,
        "|---|---|---|",
        ...diff.permissions.changes.map(
          (c) => `| ${cell(c.role)} | ${cell(c.onlyInA.join(", "))} | ${cell(c.onlyInB.join(", "))} |`,
        ),
      );
    }
  }

  return lines.join("\n");
}
