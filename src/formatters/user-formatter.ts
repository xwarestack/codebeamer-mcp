import type { CbPage, CbReference, CbUser } from "../client/codebeamer-client.js";
import { cell } from "./item-formatter.js";

export function formatUserSearch(
  query: string,
  result: CbPage<CbReference>,
  page: number,
  pageSize: number,
): string {
  const total = result.total ?? result.items.length;
  const header = `## Users matching "${query}" (${result.items.length} of ${total})`;
  if (result.items.length === 0) return `${header}\n\n_No users found._`;
  const lines = [
    header,
    "",
    "| ID | Username |",
    "|----|----------|",
    ...result.items.map((u) => `| ${u.id} | ${cell(u.name)} |`),
  ];
  if (page * pageSize < total) lines.push("", `_More users available: request page ${page + 1}._`);
  return lines.join("\n");
}

export function formatUser(user: CbUser): string {
  const lines: string[] = [
    `## ${user.firstName ?? ""} ${user.lastName ?? ""} (${user.name})`.trim(),
    "",
    `- **ID:** ${user.id}`,
    `- **Username:** ${user.name}`,
  ];

  if (user.firstName) lines.push(`- **First Name:** ${user.firstName}`);
  if (user.lastName) lines.push(`- **Last Name:** ${user.lastName}`);
  if (user.email) lines.push(`- **Email:** ${user.email}`);
  if (user.status) lines.push(`- **Status:** ${user.status}`);
  if (user.registryDate)
    lines.push(`- **Registered:** ${user.registryDate}`);

  return lines.join("\n");
}
