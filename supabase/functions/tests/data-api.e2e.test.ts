/**
 * What the Data API gives a signed-in client: functions, and no table.
 *
 * A table a client may select is a table the Data API will plan a query for,
 * and with the header `Prefer: count=planned` it answers with the planner's
 * estimate of how many rows match. That estimate is made from statistics about
 * the whole table, before any row level security applies, so it gave away how
 * many accounts, projects and audit entries an instance holds and, filter by
 * filter, what is in them. No API role can select any table now. These tests
 * ask the real Data API, the way a browser would.
 *
 * Run with `pnpm test:supabase`. See helpers.ts.
 */
import { assert, assertEquals } from "@std/assert";
import {
  API_URL,
  newAccount,
  newProject,
  PUBLISHABLE_KEY,
  removeEverything,
  request,
  rpc,
  table,
  TABLES,
} from "./helpers.ts";

Deno.test.afterAll(removeEverything);

const COUNTS = [undefined, "count=exact", "count=planned", "count=estimated"];

Deno.test("no table can be read through the Data API, and no row count or estimate can be had", async () => {
  const person = await newAccount("reader", "Rita Reader");
  await newProject(person, "Rita's own project");

  for (const name of TABLES) {
    for (const prefer of COUNTS) {
      const reply = await table(`${name}?select=*`, person.token, prefer);
      assertEquals([reply.status, reply.body?.code], [403, "42501"], `${name} with ${prefer ?? "no count"}: ${reply.text}`);
      assertEquals(reply.headers.get("content-range"), null, `${name} with ${prefer}: no count in the answer`);
    }
    // HEAD is how a client asks for a count and no rows.
    const head = await request("HEAD", `${API_URL}/rest/v1/${name}?select=*`, {
      token: person.token,
      headers: { Prefer: "count=planned" },
    });
    assertEquals(head.status, 403, `HEAD ${name}`);
    assertEquals(head.headers.get("content-range"), null, `HEAD ${name}: no count in the answer`);
  }

  // The questions the estimate used to answer, one filter at a time.
  for (
    const query of [
      "profiles?select=id&status=eq.suspended",
      "profiles?select=id&role=in.(admin,master_admin)",
      "profiles?select=id&email=lt.m",
      `audit_log?select=id&actor_email=in.(${person.email},somebody@example.test)`,
      "projects?select=id&title=eq.Confidential",
      "project_comments?select=id&body=lt.Q",
    ]
  ) {
    const reply = await table(query, person.token, "count=planned");
    assertEquals(reply.status, 403, query);
    assertEquals(reply.headers.get("content-range"), null, query);
  }

  // Not even the caller's own rows come from a table.
  assertEquals((await table(`profiles?select=id&id=eq.${person.id}`, person.token)).status, 403);

  // A caller with no account is turned away as well.
  for (const name of TABLES) {
    const reply = await table(`${name}?select=*`, PUBLISHABLE_KEY, "count=planned");
    assertEquals(reply.status, 401, `${name} without an account`);
    assertEquals(reply.headers.get("content-range"), null);
  }
});

Deno.test("a count asked of a function says nothing about the tables behind it", async () => {
  const person = await newAccount("counter");
  for (const fn of ["list_my_projects", "my_account", "my_profile", "admin_list_users"]) {
    for (const prefer of ["count=planned", "count=estimated", "count=exact"]) {
      const reply = await rpc(fn, {}, person.token, { headers: { Prefer: prefer } });
      const range = reply.headers.get("content-range");
      // Either no count at all, or the count of the one value a function returns.
      assert(range === null || /\/(\*|1)$/.test(range), `${fn} with ${prefer}: ${range}`);
    }
  }
});

Deno.test("everything a client reads comes from a function", async () => {
  const owner = await newAccount("owner", "Olive Owner");
  const outsider = await newAccount("outsider");
  const project = await newProject(owner, "Olive's review");
  const content = JSON.stringify({ stepData: { question: "kept private" }, stepStatus: {} });
  const pushed = await rpc(
    "put_project_content",
    { p_project_id: project, p_content: content, p_base_rev: 0, p_updated_at: Date.now() },
    owner.token,
  );
  assertEquals([pushed.status, pushed.body.ok], [200, true], pushed.text);
  assertEquals(
    (await rpc("add_project_comment", { p_project_id: project, p_step_id: "question", p_text: "A remark." }, owner.token)).status,
    200,
  );
  assertEquals(
    (await rpc("set_project_review", { p_project_id: project, p_step_id: "question", p_status: "approved" }, owner.token)).status,
    200,
  );
  assertEquals(
    (await rpc("set_step_owner", { p_project_id: project, p_step_id: "question", p_owner_id: owner.id }, owner.token)).status,
    200,
  );

  // The caller's own account record, which the app keeps on the device.
  const account = await rpc("my_account", {}, owner.token);
  assertEquals(account.status, 200, account.text);
  assertEquals(
    Object.keys(account.body).sort(),
    ["created_at", "email", "id", "institution", "must_set_password", "name", "role", "status"],
  );
  assertEquals(
    [account.body.id, account.body.email, account.body.name, account.body.role, account.body.status],
    [owner.id, owner.email, "Olive Owner", "researcher", "active"],
  );
  assert(Number.isFinite(Date.parse(account.body.created_at)), "created_at is a timestamp the app can parse");
  // It takes no argument: asking with somebody else's id changes nothing.
  const asOther = await rpc("my_account", { p_user_id: outsider.id }, owner.token);
  assert(asOther.status >= 400, `my_account takes no argument: ${asOther.status}`);
  assertEquals((await rpc("my_account", {}, PUBLISHABLE_KEY)).status, 401, "not for a caller without an account");

  // The member reads all of the project through functions.
  const reads: [string, Record<string, unknown>, (body: Record<string, unknown>) => unknown][] = [
    ["list_my_projects", {}, (b) => (b.projects as { id: string }[]).map((p) => p.id)],
    ["get_project", { p_project_id: project }, (b) => (b.project as { id: string }).id],
    ["get_project_content", { p_project_id: project }, (b) => b.content],
    ["list_project_members", { p_project_id: project }, (b) => (b.members as unknown[]).length],
    ["list_project_comments", { p_project_id: project }, (b) => (b.comments as unknown[]).length],
    ["list_project_reviews", { p_project_id: project }, (b) => (b.reviews as unknown[]).length],
    ["list_step_ownership", { p_project_id: project }, (b) => (b.ownership as unknown[]).length],
    ["get_project_activity", { p_project_id: project }, (b) => (b.entries as unknown[]).length >= 4],
  ];
  const expected = [[project], project, content, 1, 1, 1, 1, true];
  for (const [i, [fn, args, pick]] of reads.entries()) {
    const reply = await rpc(fn, args, owner.token);
    assertEquals(reply.status, 200, `${fn}: ${reply.text}`);
    assertEquals(pick(reply.body), expected[i], fn);
  }

  // Somebody who is not a member gets the same 404 for this project as for one that does not exist.
  const missing = `proj_${crypto.randomUUID()}`;
  for (const [fn] of reads.slice(1)) {
    const theirs = await rpc(fn, { p_project_id: project }, outsider.token);
    const none = await rpc(fn, { p_project_id: missing }, outsider.token);
    assertEquals([theirs.status, theirs.body.code], [404, "not_found"], fn);
    assertEquals([none.status, none.body.code], [404, "not_found"], `${fn}, missing project`);
    assert(!theirs.text.includes("kept private"));
  }
  assertEquals((await rpc("list_my_projects", {}, outsider.token)).body, { projects: [] });

  // The administrators' reads are functions too, and closed to a researcher.
  for (const fn of ["admin_list_users", "admin_list_audit", "master_list_admins", "admin_get_settings"]) {
    const reply = await rpc(fn, {}, owner.token);
    assertEquals([reply.status, reply.body.code], [403, "forbidden"], fn);
  }
});
