import { http, HttpResponse } from "msw";
import { makeProject } from "./fixtures/projects.js";
import { makeTracker, makeTrackerField } from "./fixtures/trackers.js";
import { makeItem, makeItemRelationsPage, makeComment, makeTestCaseItem } from "./fixtures/items.js";
import { makeUser } from "./fixtures/users.js";
import { configurations, permissions, schemas, transitions } from "./fixtures/configuration.js";

const BASE = "https://test-cb.example.com/v3";

export const handlers = [
  // Configuration (listed before /trackers/:id and /users/:id so literal segments win)
  http.get(`${BASE}/tracker/:id/configuration`, ({ params }) => {
    const config = configurations[Number(params.id)];
    return config
      ? HttpResponse.json(config)
      : HttpResponse.json({ message: "Tracker not found" }, { status: 404 });
  }),

  http.get(`${BASE}/trackers/types`, () =>
    HttpResponse.json([
      { id: 1, name: "Requirement", type: "TrackerTypeReference" },
      { id: 2, name: "Bug", type: "TrackerTypeReference" },
    ]),
  ),

  http.get(`${BASE}/trackers/:id/transitions`, ({ params }) =>
    HttpResponse.json(transitions[Number(params.id)] ?? []),
  ),

  http.get(`${BASE}/trackers/:id/permissions`, ({ params, request }) => {
    const roleId = new URL(request.url).searchParams.get("roleId");
    const all = permissions[Number(params.id)] ?? [];
    return HttpResponse.json(roleId ? all.filter((p) => p.role?.id === Number(roleId)) : all);
  }),

  http.get(`${BASE}/roles`, () =>
    HttpResponse.json([
      { id: 5, name: "Developer", type: "RoleReference" },
      { id: 6, name: "Reviewer", type: "RoleReference" },
    ]),
  ),

  http.get(`${BASE}/associations/types`, () =>
    HttpResponse.json([
      { id: 1, name: "depends", description: "Depends on" },
      { id: 4, name: "related", description: "Related to" },
    ]),
  ),

  http.get(`${BASE}/projects/:projectId/members`, () =>
    HttpResponse.json({
      page: 1,
      pageSize: 100,
      total: 2,
      members: [
        { id: 5, name: "john.doe", type: "UserReference" },
        { id: 9, name: "QA Team", type: "UserGroupReference" },
      ],
    }),
  ),

  http.get(`${BASE}/users/findByEmail`, ({ request }) => {
    const email = new URL(request.url).searchParams.get("email") ?? "";
    return HttpResponse.json(makeUser({ email }));
  }),

  http.get(`${BASE}/users`, () =>
    HttpResponse.json({
      page: 1,
      pageSize: 25,
      total: 1,
      users: [{ id: 5, name: "john.doe", type: "UserReference" }],
    }),
  ),

  // Projects
  http.get(`${BASE}/projects`, () =>
    HttpResponse.json([makeProject(), makeProject({ id: 2, name: "Second Project", keyName: "SEC" })]),
  ),

  http.get(`${BASE}/projects/:id`, ({ params }) =>
    HttpResponse.json(makeProject({ id: Number(params.id) })),
  ),

  // Trackers
  http.post(`${BASE}/projects/:projectId/trackers/search`, () =>
    HttpResponse.json({
      page: 1,
      pageSize: 25,
      total: 1,
      trackers: [makeTracker({ templateTracker: { id: 900, name: "Requirements Template" } })],
    }),
  ),

  http.get(`${BASE}/projects/:projectId/trackers`, () =>
    HttpResponse.json([makeTracker()]),
  ),

  http.get(`${BASE}/trackers/:id/fields`, () =>
    HttpResponse.json([
      makeTrackerField(),
      makeTrackerField({ fieldId: 2, name: "Description", type: "WikiTextFieldValue", required: false }),
    ]),
  ),

  http.get(`${BASE}/trackers/:id/schema`, ({ params }) =>
    HttpResponse.json(schemas[Number(params.id)] ?? [
      { id: 1, name: "Summary", legacyRestName: "name" },
      { id: 3, name: "Description", legacyRestName: "description" },
      { id: 7, name: "Status", legacyRestName: "status" },
      { id: 8, name: "Priority", legacyRestName: "priority" },
      { id: 9, name: "Assigned to", legacyRestName: "assignedTo" },
      { id: 10, name: "Story Points", legacyRestName: "storyPoints" },
    ]),
  ),

  http.get(`${BASE}/trackers/:id/items`, () =>
    HttpResponse.json([makeItem()]),
  ),

  http.get(`${BASE}/trackers/:id`, ({ params }) =>
    HttpResponse.json(makeTracker({ id: Number(params.id) })),
  ),

  // Items
  http.get(`${BASE}/items/query`, () =>
    HttpResponse.json([makeItem(), makeItem({ id: 501, name: "Another bug" })]),
  ),

  http.get(`${BASE}/items/:id/relations`, () =>
    HttpResponse.json(makeItemRelationsPage()),
  ),

  http.get(`${BASE}/items/:id/comments`, () =>
    HttpResponse.json([makeComment(), makeComment({ id: 301, comment: "Fixed in v2.1", createdBy: { id: 2, name: "jane.smith" } })]),
  ),

  http.get(`${BASE}/items/:id`, ({ params }) => {
    const id = Number(params.id);
    if (id === 700) return HttpResponse.json(makeTestCaseItem());
    return HttpResponse.json(makeItem({ id }));
  }),

  // Users
  http.get(`${BASE}/users/:id`, ({ params }) =>
    HttpResponse.json(makeUser({ id: Number(params.id) })),
  ),

  // --- Write operations ---

  // Create item
  http.post(`${BASE}/trackers/:trackerId/items`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      makeItem({
        id: 600,
        name: body.name as string,
        description: body.description as string | undefined,
        status: body.status as { id: number; name: string } | undefined,
        priority: body.priority as { id: number; name: string } | undefined,
        storyPoints: body.storyPoints as number | undefined,
      }),
      { status: 201 },
    );
  }),

  // Update item via field-based endpoint
  http.put(`${BASE}/items/:id/fields`, async ({ params }) => {
    return HttpResponse.json(makeItem({ id: Number(params.id) }));
  }),

  // Add comment (multipart/form-data)
  http.post(`${BASE}/items/:itemId/comments`, async ({ request }) => {
    const fd = await request.formData();
    return HttpResponse.json(
      makeComment({
        id: 350,
        comment: fd.get("comment") as string,
        createdBy: { id: 5, name: "john.doe" },
      }),
      { status: 201 },
    );
  }),

  // Create association
  http.post(`${BASE}/associations`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      {
        id: 400,
        from: body.from,
        to: body.to,
        type: { ...(body.type as Record<string, unknown>), name: "depends on" },
        description: body.description ?? null,
      },
      { status: 201 },
    );
  }),
];
