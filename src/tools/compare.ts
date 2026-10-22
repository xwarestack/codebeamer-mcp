import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CbTracker, CodebeamerClient } from "../client/codebeamer-client.js";
import {
  buildReferenceEdges,
  compareTrackers,
  countDifferences,
  diffEdges,
  loadTrackerSnapshot,
  matchTrackersByName,
  normalizeTracker,
  resolveLookups,
  type NormalizedTracker,
  type TrackerDiff,
} from "../analysis/tracker-config.js";
import { mapLimit } from "../analysis/concurrency.js";
import { formatTrackerDiff, formatWarnings } from "../formatters/config-formatter.js";
import { cell } from "../formatters/item-formatter.js";
import { READ_ONLY } from "./annotations.js";

interface LoadOptions {
  transitions: boolean;
  permissions: boolean;
}

/** Load several trackers and normalize them with one shared reference-name lookup. */
async function loadNormalized(
  client: CodebeamerClient,
  trackerIds: number[],
  options: LoadOptions,
): Promise<NormalizedTracker[]> {
  const snapshots = await mapLimit(trackerIds, 4, (id) => loadTrackerSnapshot(client, id, options));
  const names = await resolveLookups(client, snapshots);
  return snapshots.map((s) => normalizeTracker(s, names));
}

const aspectOptions = {
  includeTransitions: z.boolean().default(true).describe("Compare workflow transitions"),
  includePermissions: z.boolean().default(true).describe("Compare role permissions on the trackers"),
};

export function registerCompareTools(
  server: McpServer,
  client: CodebeamerClient,
): void {
  server.registerTool(
    "compare_trackers",
    {
      title: "Compare Trackers",
      description:
        "Compare the configuration of two trackers (same or different projects): settings, fields and their rules, " +
        "choice options (enums), reference targets, statuses, transitions and role permissions. " +
        "Fields are matched by built-in identity or by name.",
      inputSchema: {
        trackerIdA: z.number().int().positive().describe("First tracker ID (reported as A)"),
        trackerIdB: z.number().int().positive().describe("Second tracker ID (reported as B)"),
        ...aspectOptions,
      },
      annotations: READ_ONLY,
    },
    async ({ trackerIdA, trackerIdB, includeTransitions, includePermissions }) => {
      const [a, b] = await loadNormalized(client, [trackerIdA, trackerIdB], {
        transitions: includeTransitions,
        permissions: includePermissions,
      });
      const text = formatTrackerDiff(compareTrackers(a, b)) + formatWarnings([...a.warnings, ...b.warnings]);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "compare_tracker_with_template",
    {
      title: "Compare Tracker with Its Template",
      description:
        "Compare a tracker with the template tracker it was derived from, to find local deviations from the " +
        "template configuration (fields, options, statuses, transitions, permissions).",
      inputSchema: {
        trackerId: z.number().int().positive().describe("ID of the derived tracker"),
        ...aspectOptions,
      },
      annotations: READ_ONLY,
    },
    async ({ trackerId, includeTransitions, includePermissions }) => {
      const config = await client.getTrackerConfiguration(trackerId);
      const templateId = config.basicInformation?.templateId;
      if (!templateId) {
        return {
          content: [
            {
              type: "text",
              text:
                `Tracker ${trackerId} ("${config.basicInformation?.name ?? "?"}") has no template ` +
                `(templateId is not set${config.basicInformation?.template ? "; it is itself a template" : ""}).`,
            },
          ],
        };
      }
      const [template, tracker] = await loadNormalized(client, [templateId, trackerId], {
        transitions: includeTransitions,
        permissions: includePermissions,
      });
      const text =
        formatTrackerDiff(compareTrackers(template, tracker), { a: "Template", b: "Tracker" }) +
        formatWarnings([...template.warnings, ...tracker.warnings]);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "compare_projects",
    {
      title: "Compare Projects",
      description:
        "Compare the tracker setup of two projects. Trackers are matched by name. The quick mode lists trackers " +
        "present in only one project and tracker-type mismatches. deep=true also compares the configuration of " +
        "every matched tracker pair and the cross-tracker reference graph (slower: several requests per tracker).",
      inputSchema: {
        projectIdA: z.number().int().positive().describe("First project ID (reported as A)"),
        projectIdB: z.number().int().positive().describe("Second project ID (reported as B)"),
        deep: z.boolean().default(false).describe("Compare each matched tracker's configuration"),
        includePermissions: z.boolean().default(false).describe("Deep mode: also compare role permissions"),
        includeDetails: z
          .boolean()
          .default(false)
          .describe("Deep mode: append the full difference report of every differing tracker pair"),
      },
      annotations: READ_ONLY,
    },
    async ({ projectIdA, projectIdB, deep, includePermissions, includeDetails }) => {
      const [projectA, projectB, listA, listB] = await Promise.all([
        client.getProject(projectIdA),
        client.getProject(projectIdB),
        client.listTrackers(projectIdA),
        client.listTrackers(projectIdB),
      ]);

      // The fallback tracker list only contains references; tracker details carry the tracker type.
      const details = async (trackers: CbTracker[]) =>
        mapLimit(trackers, 5, async (t) => {
          if (t.type?.name) return t;
          try {
            return await client.getTracker(t.id);
          } catch {
            return t;
          }
        });
      const [trackersA, trackersB] = await Promise.all([details(listA), details(listB)]);
      const { pairs, onlyInA, onlyInB } = matchTrackersByName(trackersA, trackersB);

      const lines = [
        `## Project comparison: A = ${projectA.name} [${projectIdA}] vs B = ${projectB.name} [${projectIdB}]`,
        "",
        `${trackersA.length} trackers in A, ${trackersB.length} in B, ${pairs.length} matched by name.`,
      ];
      const listTrackers = (title: string, trackers: CbTracker[]) => {
        if (trackers.length > 0) {
          lines.push("", `### ${title}`, "", ...trackers.map((t) => `- ${t.name} [${t.id}] (${t.type?.name ?? "type ?"})`));
        }
      };
      listTrackers("Only in A", onlyInA);
      listTrackers("Only in B", onlyInB);

      const typeMismatches = pairs.filter(([a, b]) => a.type?.name !== b.type?.name);
      if (typeMismatches.length > 0) {
        lines.push(
          "",
          "### Tracker type differences",
          "",
          "| Tracker | Type in A | Type in B |",
          "|---|---|---|",
          ...typeMismatches.map(([a, b]) => `| ${cell(a.name)} | ${cell(a.type?.name)} | ${cell(b.type?.name)} |`),
        );
      }

      if (!deep) {
        lines.push("", "_Run with deep=true to compare the configuration of matched trackers._");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const warnings: string[] = [];
      const loaded = await loadNormalizedPairs(client, pairs, { transitions: true, permissions: includePermissions }, warnings);
      const diffs: TrackerDiff[] = loaded.map(([a, b]) => compareTrackers(a, b));

      lines.push(
        "",
        "### Matched trackers",
        "",
        "| Tracker | A | B | Settings | Fields | Statuses | Transitions | Permissions |",
        "|---|---|---|---|---|---|---|---|",
        ...diffs.map((d) => {
          const c = countDifferences(d);
          return `| ${cell(d.a.name)} | ${d.a.id} | ${d.b.id} | ${c.settings} | ${c.fields} | ${c.statuses} | ${c.transitions} | ${d.permissions ? c.permissions : "-"} |`;
        }),
      );

      const edges = diffEdges(
        buildReferenceEdges(loaded.map(([a]) => a)),
        buildReferenceEdges(loaded.map(([, b]) => b)),
      );
      if (edges.onlyInA.length + edges.onlyInB.length > 0) {
        lines.push("", "### Reference graph differences (matched trackers)");
        if (edges.onlyInA.length > 0) lines.push("", "**Only in A:**", ...edges.onlyInA.map((e) => `- ${e}`));
        if (edges.onlyInB.length > 0) lines.push("", "**Only in B:**", ...edges.onlyInB.map((e) => `- ${e}`));
      }

      if (includeDetails) {
        for (const diff of diffs.filter((d) => countDifferences(d).total > 0)) {
          lines.push("", "---", "", formatTrackerDiff(diff));
        }
      } else if (diffs.some((d) => countDifferences(d).total > 0)) {
        lines.push("", "_Use compare_trackers on a pair (or includeDetails=true) for the full difference report._");
      }

      warnings.push(...loaded.flatMap(([a, b]) => [...a.warnings, ...b.warnings]));
      lines.push(formatWarnings(warnings));
      return { content: [{ type: "text", text: lines.join("\n").trimEnd() }] };
    },
  );
}

/** Load matched tracker pairs, skipping (with a warning) pairs whose configuration is not accessible. */
async function loadNormalizedPairs(
  client: CodebeamerClient,
  pairs: Array<[CbTracker, CbTracker]>,
  options: LoadOptions,
  warnings: string[],
): Promise<Array<[NormalizedTracker, NormalizedTracker]>> {
  const snapshots = await mapLimit(pairs, 3, async ([a, b]) => {
    try {
      return await Promise.all([
        loadTrackerSnapshot(client, a.id, options),
        loadTrackerSnapshot(client, b.id, options),
      ]);
    } catch (err) {
      warnings.push(`${a.name} [${a.id} / ${b.id}]: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  });
  const loaded = snapshots.filter((s): s is NonNullable<typeof s> => s !== undefined);
  const names = await resolveLookups(client, loaded.flat());
  return loaded.map(([a, b]) => [normalizeTracker(a, names), normalizeTracker(b, names)]);
}
