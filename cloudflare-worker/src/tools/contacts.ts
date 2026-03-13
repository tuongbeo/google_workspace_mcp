/**
 * Google Contacts (People API) MCP Tools — Full implementation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

const PEOPLE_BASE = "https://people.googleapis.com/v1";
const FIELDS = "names,emailAddresses,phoneNumbers,organizations,addresses,biographies,birthdays,resourceName";

export function registerContactsTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("list_contacts", "List Google Contacts.", {
    page_size: z.number().optional().default(20),
    query: z.string().optional(),
  }, async ({ page_size = 20, query }) => {
    const { accessToken } = await getCreds();
    let url: string;
    if (query) {
      url = `${PEOPLE_BASE}/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers&pageSize=${page_size}`;
    } else {
      url = `${PEOPLE_BASE}/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=${page_size}&sortOrder=FIRST_NAME_ASCENDING`;
    }
    const data = await googleFetch(url, accessToken) as any;
    const contacts = data.results?.map((r: any) => r.person) || data.connections || [];
    if (!contacts.length) return { content: [{ type: "text", text: "No contacts found." }] };
    const lines = contacts.map((c: any) => {
      const name = c.names?.[0]?.displayName || "Unknown";
      const email = c.emailAddresses?.[0]?.value || "";
      const phone = c.phoneNumbers?.[0]?.value || "";
      const rn = c.resourceName || "";
      return `- ${name}${email ? " | " + email : ""}${phone ? " | " + phone : ""} | ${rn}`;
    });
    return { content: [{ type: "text", text: `Contacts (${contacts.length}):\n${lines.join("\n")}` }] };
  });

  server.tool("search_contacts", "Search Google Contacts by name, email, or phone.", {
    query: z.string(),
    page_size: z.number().optional().default(10),
  }, async ({ query, page_size = 10 }) => {
    const { accessToken } = await getCreds();
    const url = `${PEOPLE_BASE}/people:searchContacts?query=${encodeURIComponent(query)}&readMask=${FIELDS}&pageSize=${page_size}`;
    const data = await googleFetch(url, accessToken) as any;
    const contacts = (data.results || []).map((r: any) => r.person);
    if (!contacts.length) return { content: [{ type: "text", text: `No contacts found for: "${query}"` }] };
    const lines = contacts.map((c: any) => formatContact(c));
    return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
  });

  server.tool("get_contact", "Get detailed info of a specific Google Contact.", {
    resource_name: z.string().describe("Contact resource name, e.g. 'people/c123456'"),
  }, async ({ resource_name }) => {
    const { accessToken } = await getCreds();
    const contact = await googleFetch(`${PEOPLE_BASE}/${resource_name}?personFields=${FIELDS}`, accessToken) as any;
    return { content: [{ type: "text", text: formatContact(contact) }] };
  });

  server.tool("create_contact", "Create a new Google Contact.", {
    first_name: z.string(),
    last_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    job_title: z.string().optional(),
    notes: z.string().optional(),
  }, async ({ first_name, last_name, email, phone, company, job_title, notes }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { names: [{ givenName: first_name, familyName: last_name || "" }] };
    if (email) body.emailAddresses = [{ value: email }];
    if (phone) body.phoneNumbers = [{ value: phone }];
    if (company || job_title) body.organizations = [{ name: company || "", title: job_title || "" }];
    if (notes) body.biographies = [{ value: notes }];
    const result = await googleFetch(`${PEOPLE_BASE}/people:createContact`, accessToken, "POST", body) as any;
    return { content: [{ type: "text", text: `Contact created: "${result.names?.[0]?.displayName}"\nResource: ${result.resourceName}` }] };
  });

  server.tool("update_contact", "Update a Google Contact.", {
    resource_name: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    job_title: z.string().optional(),
    notes: z.string().optional(),
  }, async ({ resource_name, first_name, last_name, email, phone, company, job_title, notes }) => {
    const { accessToken } = await getCreds();
    const existing = await googleFetch(`${PEOPLE_BASE}/${resource_name}?personFields=${FIELDS}`, accessToken) as any;
    const body: Record<string, unknown> = { etag: existing.etag };
    const updateFields: string[] = [];
    if (first_name !== undefined || last_name !== undefined) {
      const n = existing.names?.[0] || {};
      body.names = [{ ...n, givenName: first_name ?? n.givenName, familyName: last_name ?? n.familyName }];
      updateFields.push("names");
    }
    if (email !== undefined) { body.emailAddresses = [{ value: email }]; updateFields.push("emailAddresses"); }
    if (phone !== undefined) { body.phoneNumbers = [{ value: phone }]; updateFields.push("phoneNumbers"); }
    if (company !== undefined || job_title !== undefined) { body.organizations = [{ name: company || "", title: job_title || "" }]; updateFields.push("organizations"); }
    if (notes !== undefined) { body.biographies = [{ value: notes }]; updateFields.push("biographies"); }
    const result = await googleFetch(`${PEOPLE_BASE}/${resource_name}:updateContact?updatePersonFields=${updateFields.join(",")}`, accessToken, "PATCH", body) as any;
    return { content: [{ type: "text", text: `Contact updated: "${result.names?.[0]?.displayName}"` }] };
  });

  server.tool("delete_contact", "Delete a Google Contact.", {
    resource_name: z.string(),
  }, async ({ resource_name }) => {
    const { accessToken } = await getCreds();
    await googleFetch(`${PEOPLE_BASE}/${resource_name}:deleteContact`, accessToken, "DELETE");
    return { content: [{ type: "text", text: `Contact ${resource_name} deleted.` }] };
  });

  server.tool("list_contact_groups", "List Google Contact groups/labels.", {}, async () => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`${PEOPLE_BASE}/contactGroups?pageSize=50`, accessToken) as any;
    const groups = (data.contactGroups || []).map((g: any) => `- ${g.name} (${g.groupType}) | ID: ${g.resourceName} | Members: ${g.memberCount || 0}`);
    return { content: [{ type: "text", text: `Contact Groups:\n${groups.join("\n")}` }] };
  });

  server.tool("get_contact_group", "Get details of a contact group with its members.", {
    resource_name: z.string().describe("Group resource name, e.g. 'contactGroups/123'"),
    max_members: z.number().optional().default(50),
  }, async ({ resource_name, max_members = 50 }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`${PEOPLE_BASE}/${resource_name}?maxMembers=${max_members}`, accessToken) as any;
    const lines = [`Group: ${data.name}`, `Type: ${data.groupType}`, `Members: ${data.memberCount || 0}`, `Resource: ${data.resourceName}`];
    if (data.memberResourceNames?.length) lines.push(`\nMember resources:\n${data.memberResourceNames.join("\n")}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("create_contact_group", "Create a new Google Contact group.", {
    name: z.string(),
  }, async ({ name }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`${PEOPLE_BASE}/contactGroups`, accessToken, "POST", { contactGroup: { name } }) as any;
    return { content: [{ type: "text", text: `Group created: "${result.name}" (${result.resourceName})` }] };
  });

  server.tool("delete_contact_group", "Delete a Google Contact group.", {
    resource_name: z.string(),
    delete_contacts: z.boolean().optional().default(false).describe("Also delete all contacts in the group"),
  }, async ({ resource_name, delete_contacts = false }) => {
    const { accessToken } = await getCreds();
    await googleFetch(`${PEOPLE_BASE}/${resource_name}?deleteContacts=${delete_contacts}`, accessToken, "DELETE");
    return { content: [{ type: "text", text: `Group ${resource_name} deleted.` }] };
  });

  server.tool("modify_contact_group_members", "Add or remove contacts from a group.", {
    resource_name: z.string().describe("Group resource name"),
    add_resource_names: z.array(z.string()).optional().describe("Contact resource names to add"),
    remove_resource_names: z.array(z.string()).optional().describe("Contact resource names to remove"),
  }, async ({ resource_name, add_resource_names = [], remove_resource_names = [] }) => {
    const { accessToken } = await getCreds();
    await googleFetch(`${PEOPLE_BASE}/${resource_name}/members:modify`, accessToken, "POST", {
      resourceNamesToAdd: add_resource_names, resourceNamesToRemove: remove_resource_names,
    });
    return { content: [{ type: "text", text: `Group members modified. Added: ${add_resource_names.length}, Removed: ${remove_resource_names.length}` }] };
  });
}

function formatContact(c: any): string {
  const lines = [
    `Name: ${c.names?.[0]?.displayName || "Unknown"}`,
    `Resource: ${c.resourceName}`,
  ];
  if (c.emailAddresses?.length) lines.push(`Emails: ${c.emailAddresses.map((e: any) => e.value).join(", ")}`);
  if (c.phoneNumbers?.length) lines.push(`Phones: ${c.phoneNumbers.map((p: any) => p.value).join(", ")}`);
  if (c.organizations?.length) {
    const org = c.organizations[0];
    if (org.name) lines.push(`Company: ${org.name}${org.title ? " / " + org.title : ""}`);
  }
  if (c.addresses?.length) lines.push(`Address: ${c.addresses[0].formattedValue || ""}`);
  if (c.biographies?.length) lines.push(`Notes: ${c.biographies[0].value?.substring(0, 100)}`);
  return lines.join("\n");
}
