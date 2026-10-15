# servicenow-mcp

An MCP server that connects Claude (or any MCP client) to your own ServiceNow instance through its standard REST API (Table API and Attachment API).

- Works with any instance: a personal developer instance or a company one.
- You sign in as yourself in the browser (OAuth with PKCE). No password is ever typed into or stored by this tool, and it can only see what your ServiceNow user can see.
- Read-only unless you turn writes on.
- Changes can go through a plan: you see the exact before and after of every field before anything is written, and you can undo it or check it for drift later.
- One file, Node 18 or newer, no npm packages.

## Quick start

There are three steps: register an OAuth client on your instance (once), sign in, and add the server to your MCP client.

### 1. Register an OAuth client on your instance

This needs the admin role. On a company instance, ask your ServiceNow admin to do it and send you the client id.

1. In ServiceNow open **System OAuth > Application Registry** and choose **New**, then the option to create an OAuth API endpoint for external clients (on newer releases this is called a new inbound integration).
2. Grant type: **Authorization code**.
3. Client type: **Public** (no client secret, PKCE is used instead).
4. Redirect URL: `http://localhost:8787/callback`
5. Save it and copy the **Client ID**.

One client id can be shared by everyone on the same instance. Each person still signs in as themselves.

### 2. Sign in

```
npx -y github:MDK-s-Organisation/servicenow-mcp login
```

It asks for your instance and the client id, then opens the ServiceNow sign in page in your browser. When you approve, the tab says you can close it and the terminal prints who you are signed in as.

For the instance you can type the short name (`dev12345`), the host (`acme.service-now.com`) or the full URL (`https://acme.service-now.com`).

You can also pass everything up front:

```
npx -y github:MDK-s-Organisation/servicenow-mcp login --instance dev12345 --client-id <id>
```

Options: `--instance <url or name>`, `--client-id <id>`, `--port <n>` (default 8787, must match the redirect URL), `--no-open` (only print the link, do not open the browser).

### 3. Add it to your MCP client

`login` saves the instance, client id and port, so the server needs no extra settings.

Claude Code:

```
claude mcp add servicenow -- npx -y github:MDK-s-Organisation/servicenow-mcp
```

Claude Desktop, Cursor, VS Code and other clients that use a JSON config:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "github:MDK-s-Organisation/servicenow-mcp"]
    }
  }
}
```

Then ask your assistant something like "show my instance info" to check the connection.

## Running from a clone

If you prefer not to use `npx`:

```
git clone https://github.com/MDK-s-Organisation/servicenow-mcp.git
cd servicenow-mcp
node server.mjs login
```

There is nothing to build and nothing to `npm install`. Register it with the absolute path to the file:

```
claude mcp add servicenow -- node /absolute/path/to/servicenow-mcp/server.mjs
```

## Commands

```
node server.mjs            # run as an MCP server over stdio (what the MCP client starts)
node server.mjs login      # sign in
node server.mjs status     # instance, signed in or not, token expiry, write mode, plans folder
node server.mjs logout     # delete the saved tokens
```

With `npx`, put the command after the package name, for example `npx -y github:MDK-s-Organisation/servicenow-mcp status`.

## Tools

Read tools, always available:

| Tool | What it does |
| --- | --- |
| `sn_instance_info` | Instance URL, signed in user, build tag, whether writes are allowed |
| `sn_table_query` | Query a table (encoded query, fields, limit up to 200, offset, order, display values) |
| `sn_table_get` | Read one record by sys_id |
| `sn_table_schema` | Columns of a table, from sys_dictionary |
| `sn_attachment_list` | List attachments of a table or a record |
| `sn_attachment_download` | Save an attachment to a local file (never returns the contents) |

Write tools, listed but refused unless writes are on:

| Tool | What it does |
| --- | --- |
| `sn_table_create` | Create a record |
| `sn_table_update` | Change fields on a record |
| `sn_table_delete` | Delete a record |
| `sn_attachment_upload` | Attach a local file to a record |
| `sn_attachment_delete` | Delete an attachment |

Reviewed changes, see [Reviewed changes](#reviewed-changes-plan-apply-undo-check):

| Tool | What it does |
| --- | --- |
| `sn_plan_change` | Save a plan with the before and after of every field, and check each value against the dictionary. Only reads ServiceNow, so it works with writes off |
| `sn_apply_plan` | Write a plan, after checking the record did not change since. Then read it back and report any difference |
| `sn_undo_plan` | Put the old values back (or delete the record the plan created), unless someone changed them since |
| `sn_check_plan` | Compare a plan with the record as it is now: can it still be applied, or has it drifted |

## Read-only by default

There are three settings for `SN_ALLOW_WRITE`:

| Value | What can write |
| --- | --- |
| not set | Nothing. Plans can still be made and checked, but not applied |
| `plan` | Only `sn_apply_plan` and `sn_undo_plan`. The direct create, update, delete and upload tools refuse, so every change is a plan someone looked at first |
| `1` | Every write tool. Plans are there when you want them |

Set it where the server is registered:

```
claude mcp add servicenow -e SN_ALLOW_WRITE=plan -- npx -y github:MDK-s-Organisation/servicenow-mcp
```

In a JSON config, add `"env": { "SN_ALLOW_WRITE": "plan" }` next to `command` and `args`.

A refused tool returns a clear message and sends nothing to ServiceNow. Even with writes on, the server can only do what your ServiceNow user is allowed to do.

## Reviewed changes: plan, apply, undo, check

Say you ask: "put INC0010023 on hold and assign it to Bob".

1. **Plan.** The assistant calls `sn_plan_change`. The server reads the record and saves a plan like this one. Nothing is written.

   ```
   plan 20261016-101500-1a2b3c4d   incident <sys_id>
     state        "2"                 ->  "3"
     assigned_to  "<sys_id>" (Ada)    ->  "<Bob's sys_id>"
     priority     already "2", left out
   ```

   The plan also keeps the record's `sys_mod_count`, the counter ServiceNow raises on every save.
2. **Review.** The assistant shows you the plan and asks. If you say no, nothing ever reaches the instance.
3. **Apply.** `sn_apply_plan` reads the record again. If the counter moved, someone changed the record after you reviewed it, so it stops and writes nothing. Otherwise it sends exactly the planned fields, reads the record back, and tells you about any field ServiceNow stored differently, for example because a business rule changed it.
4. **Undo.** If the result is not what you wanted, `sn_undo_plan` puts the old values back. It refuses if someone changed those fields since, so it never overwrites later work. Fields outside the plan are left alone. For a plan that created a record, undo deletes that record.
5. **Check.** `sn_check_plan` can run any time later. It lists each planned field that no longer holds what the plan left there, with the value now and who changed the record last.

### Field checks while planning

Many failed first tries can be seen before anyone reviews the plan. While planning, `sn_plan_change` reads the dictionary of the table and of the tables it extends (incident extends task), including dictionary overrides, and checks every planned value:

| Check | Example warning |
| --- | --- |
| Choice list | `"4" is not a choice for incident.state. The choices are: 1 (New), 2 (In Progress), ...` |
| Reference | `"Bob Caller" is not a sys_id`, or `There is no sys_user record with sys_id ...` |
| Type | `"high" is not a whole number, but priority is an integer column`, and the same for true or false and decimal columns |
| Length | `The value is 200 characters long, but short_description holds at most 160` |
| Read only | `number is read only in the dictionary` |
| Mandatory | a mandatory column the plan empties, or for a new record, one it leaves out and that has no default |

Choices come from the nearest table that defines any, the same way ServiceNow picks them: incident has its own state choices, so the ones of task do not count for an incident. For a new record, a column that does not exist on the table or its parents stops the plan. Everything else is a warning saved with the plan, so the assistant can fix the plan before showing it to you, or show you the warnings next to the changes.

The checks only read. If the dictionary cannot be read, for example because your user may not read `sys_dictionary`, the plan is still made and carries one warning saying the checks were skipped.

When the first try does not work:

- **ServiceNow refuses the write** (an ACL or a data policy). Nothing changed. The plan stays unapplied with the reason kept in it, and the assistant makes a new plan for you to review.
- **The write lands but is wrong.** Undo it in one call, then plan again.
- **It takes several tries.** Each try is a different change, so it needs a fresh look. To keep the rounds down, try things on a sub-production instance first and bring only the final plan to the instance that matters.

Give reference fields as sys_ids and choice fields as their stored values, the form `sn_table_get` returns by default, so the plan compares like with like.

Plans are JSON files in the `plans` folder next to the config file (`~/.config/servicenow-mcp/plans` by default). The folder is mode 0700 and each file 0600. A plan only works on the instance it was made for, and the server checks a plan file again before using it, in case it was edited by hand.

Limits:

- The Table API has no "update only if unchanged" option. A change that lands in the moment between the final check and the write is not caught then, but the read back and `sn_check_plan` show it.
- One record per plan, and only creates and updates. Deletes and attachments do not go through plans.
- The field checks read the dictionary, not data policies, business rules or ACLs, so a write can still be refused or changed for those reasons. The read back after the write shows what was stored.
- The approval is the assistant showing you the plan and your MCP client asking before it runs `sn_apply_plan`. The server has no approve button of its own.

## Settings

Environment variables, all optional once you have signed in:

| Variable | Default |
| --- | --- |
| `SN_INSTANCE` | none, `login` asks for it or takes `--instance` |
| `SN_CLIENT_ID` | none, `login` asks for it or takes `--client-id` |
| `SN_CLIENT_SECRET` | none, only for an OAuth client that was registered with a secret |
| `SN_REDIRECT_PORT` | `8787` |
| `SN_TOKEN_FILE` | `~/.config/servicenow-mcp/tokens.json` |
| `SN_CONFIG_FILE` | `~/.config/servicenow-mcp/config.json` |
| `SN_ALLOW_WRITE` | unset, writes are off unless this is exactly `1` (every write tool) or `plan` (only through plans) |
| `SN_PLAN_DIR` | `plans` in the folder of the config file |

The config file may hold `instance`, `clientId`, `redirectPort` and `allowWrite` (`true` or `"plan"`). Environment variables win over the file.

If your admin registered a confidential client (one with a secret), set `SN_CLIENT_SECRET` both when you run `login` and where the server is registered. The secret is read from the environment only and is never written to disk by this tool.

To use two instances, give each its own files with `SN_TOKEN_FILE` and `SN_CONFIG_FILE`, and register the server twice under different names. Each one keeps its plans next to its own config file.

## Where tokens are kept

Tokens are stored in `~/.config/servicenow-mcp/tokens.json`. The folder is created with mode 0700 and the file with mode 0600, so only your user can read it. The access token is renewed automatically with the refresh token. Tokens are never printed, logged or returned by any tool. The instance must use https (plain http is accepted for localhost only), and a saved sign in is never sent to a different instance.

To sign out run the `logout` command. This deletes the token file. To also end the session on the ServiceNow side, revoke the token there under **System OAuth > Manage Tokens**.

## Troubleshooting

- **"No ServiceNow instance is set"**: run `login` first, or set `SN_INSTANCE`.
- **The browser shows an invalid redirect error**: the redirect URL on the OAuth client must be exactly `http://localhost:8787/callback`. If you use `--port`, change it on the instance too.
- **"ServiceNow answered with a redirect instead of data"**: a developer instance goes to sleep when unused. Wake it at developer.servicenow.com and try again.
- **A table returns nothing or a 403**: your ServiceNow user lacks access to it. The server never goes around ServiceNow access controls.

## Tests

```
node test/run-tests.mjs
```

The tests start a local mock of ServiceNow (`test/mock-servicenow.mjs`), run the whole sign in flow and every tool against it, and print PASS or FAIL lines. They never contact a real instance, never open a browser, and keep their token and config files in a temporary folder.

## License

MIT, see [LICENSE](LICENSE).
