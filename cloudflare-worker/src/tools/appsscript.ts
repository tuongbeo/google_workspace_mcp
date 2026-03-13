/**
 * Google Apps Script MCP Tools — Full implementation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

const SCRIPT_BASE = "https://script.googleapis.com/v1";

export function registerAppsScriptTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("list_script_projects", "List Google Apps Script projects accessible to the user.", {
    page_size: z.number().optional().default(20),
  }, async ({ page_size = 20 }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ mimeType: "application/vnd.google-apps.script", pageSize: String(page_size), fields: "files(id,name,modifiedTime,webViewLink)" });
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: "No Apps Script projects found." }] };
    const lines = files.map((f: any) => `- ${f.name}\n  ID: ${f.id}\n  Modified: ${f.modifiedTime}\n  Link: ${f.webViewLink}`);
    return { content: [{ type: "text", text: `Apps Script Projects (${files.length}):\n\n${lines.join("\n\n")}` }] };
  });

  server.tool("get_script_project", "Get a Google Apps Script project with all its files.", {
    script_id: z.string().describe("Script project ID (from Drive file ID)"),
  }, async ({ script_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/content`, accessToken) as any;
    const lines = [`Script ID: ${script_id}`, `Files: ${(data.files || []).length}`, ""];
    for (const f of data.files || []) {
      lines.push(`--- ${f.name}.${f.type === "SERVER_JS" ? "gs" : f.type.toLowerCase()} ---`);
      lines.push((f.source || "").substring(0, 500));
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("get_script_content", "Get content of a specific file in an Apps Script project.", {
    script_id: z.string(),
    file_name: z.string().describe("File name (without extension)"),
  }, async ({ script_id, file_name }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/content`, accessToken) as any;
    const file = (data.files || []).find((f: any) => f.name === file_name);
    if (!file) return { content: [{ type: "text", text: `File "${file_name}" not found in project.` }] };
    return { content: [{ type: "text", text: `${file.name} (${file.type}):\n\n${file.source || ""}` }] };
  });

  server.tool("create_script_project", "Create a new Google Apps Script project.", {
    title: z.string(),
    parent_id: z.string().optional().describe("Parent Drive file ID to bind to (e.g., Sheets/Docs ID)"),
  }, async ({ title, parent_id }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { title };
    if (parent_id) body.parentId = parent_id;
    const result = await googleFetch(`${SCRIPT_BASE}/projects`, accessToken, "POST", body) as any;
    return { content: [{ type: "text", text: `Script project created: "${result.title}"\nID: ${result.scriptId}\nURL: https://script.google.com/d/${result.scriptId}/edit` }] };
  });

  server.tool("update_script_content", "Create or update files in a Google Apps Script project.", {
    script_id: z.string(),
    files: z.array(z.object({
      name: z.string(),
      type: z.enum(["SERVER_JS", "HTML", "JSON"]).optional().default("SERVER_JS"),
      source: z.string(),
    })).describe("Files to write (replaces existing files with same name)"),
  }, async ({ script_id, files }) => {
    const { accessToken } = await getCreds();
    // Fetch existing files first
    const existing = await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/content`, accessToken) as any;
    const existingFiles = existing.files || [];
    // Merge: replace or add
    const merged = [...existingFiles];
    for (const newFile of files) {
      const idx = merged.findIndex((f: any) => f.name === newFile.name);
      if (idx >= 0) merged[idx] = { ...merged[idx], source: newFile.source };
      else merged.push({ name: newFile.name, type: newFile.type, source: newFile.source });
    }
    await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/content`, accessToken, "PUT", { files: merged });
    return { content: [{ type: "text", text: `Updated ${files.length} file(s) in script project ${script_id}.` }] };
  });

  server.tool("run_script_function", "Execute a function in a Google Apps Script project.", {
    script_id: z.string(),
    function_name: z.string(),
    parameters: z.array(z.any()).optional().default([]).describe("Function parameters"),
    dev_mode: z.boolean().optional().default(false).describe("Run latest saved version (dev mode)"),
  }, async ({ script_id, function_name, parameters = [], dev_mode = false }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`${SCRIPT_BASE}/scripts/${script_id}:run`, accessToken, "POST", {
      function: function_name, parameters, devMode: dev_mode,
    }) as any;
    if (result.error) {
      const err = result.error.details?.[0];
      return { content: [{ type: "text", text: `Script error: ${err?.errorMessage || JSON.stringify(result.error)}\nType: ${err?.errorType || "UNKNOWN"}` }] };
    }
    const returnVal = result.response?.result;
    return { content: [{ type: "text", text: `Function "${function_name}" executed successfully.\nReturn value: ${JSON.stringify(returnVal, null, 2)}` }] };
  });

  server.tool("list_script_deployments", "List deployments of a Google Apps Script project.", {
    script_id: z.string(),
  }, async ({ script_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/deployments`, accessToken) as any;
    const deployments = data.deployments || [];
    if (!deployments.length) return { content: [{ type: "text", text: "No deployments found." }] };
    const lines = deployments.map((d: any) =>
      `- ID: ${d.deploymentId}\n  Config: ${d.deploymentConfig?.description || "N/A"}\n  Version: ${d.deploymentConfig?.versionNumber || "HEAD"}\n  Updated: ${d.updateTime}`
    );
    return { content: [{ type: "text", text: `Deployments (${deployments.length}):\n\n${lines.join("\n\n")}` }] };
  });

  server.tool("create_script_deployment", "Create a new deployment for a Google Apps Script project.", {
    script_id: z.string(),
    version_number: z.number().optional().describe("Version to deploy (omit for HEAD/latest)"),
    description: z.string().optional(),
    manifest_file_name: z.string().optional().default("appsscript"),
  }, async ({ script_id, version_number, description, manifest_file_name = "appsscript" }) => {
    const { accessToken } = await getCreds();
    const config: Record<string, unknown> = { manifestFileName: manifest_file_name };
    if (version_number) config.versionNumber = version_number;
    if (description) config.description = description;
    const result = await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/deployments`, accessToken, "POST", { deploymentConfig: config }) as any;
    return { content: [{ type: "text", text: `Deployment created.\nID: ${result.deploymentId}\nUpdated: ${result.updateTime}` }] };
  });

  server.tool("update_script_deployment", "Update an existing Apps Script deployment.", {
    script_id: z.string(),
    deployment_id: z.string(),
    version_number: z.number().optional(),
    description: z.string().optional(),
  }, async ({ script_id, deployment_id, version_number, description }) => {
    const { accessToken } = await getCreds();
    const config: Record<string, unknown> = {};
    if (version_number) config.versionNumber = version_number;
    if (description) config.description = description;
    const result = await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/deployments/${deployment_id}`, accessToken, "PUT", { deploymentConfig: config }) as any;
    return { content: [{ type: "text", text: `Deployment ${deployment_id} updated.` }] };
  });

  server.tool("delete_script_deployment", "Delete an Apps Script deployment.", {
    script_id: z.string(),
    deployment_id: z.string(),
  }, async ({ script_id, deployment_id }) => {
    const { accessToken } = await getCreds();
    await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/deployments/${deployment_id}`, accessToken, "DELETE");
    return { content: [{ type: "text", text: `Deployment ${deployment_id} deleted.` }] };
  });

  server.tool("list_script_processes", "List recent execution processes for a Google Apps Script project.", {
    script_id: z.string().optional().describe("Filter by script ID"),
    page_size: z.number().optional().default(20),
  }, async ({ script_id, page_size = 20 }) => {
    const { accessToken } = await getCreds();
    const params: Record<string, string> = { pageSize: String(page_size) };
    if (script_id) params["userProcessFilter.scriptId"] = script_id;
    const query = new URLSearchParams(params);
    const data = await googleFetch(`${SCRIPT_BASE}/processes?${query}`, accessToken) as any;
    const processes = data.processes || [];
    if (!processes.length) return { content: [{ type: "text", text: "No processes found." }] };
    const lines = processes.map((p: any) =>
      `- Function: ${p.functionName || "N/A"}\n  Status: ${p.processStatus}\n  Type: ${p.processType}\n  Start: ${p.startTime}\n  Duration: ${p.duration || "N/A"}`
    );
    return { content: [{ type: "text", text: `Processes (${processes.length}):\n\n${lines.join("\n\n")}` }] };
  });
}
