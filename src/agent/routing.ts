/**
 * Which mailbox a reply leaves from.
 *
 * - Event conversations: events@, on the Tripleseat thread or by email, with events@ copied.
 * - Solstice, Bodega and yoga questions: the department's own address (solstice@, bodega@, yoga@).
 * - Anything else: info@.
 */

import { agentConfig } from "./config.js";

export interface Route {
  fromMailbox: string;
  cc: string[];
  transport: "tripleseat_relay" | "email_from_events" | "email_from_department" | "email_from_info";
}

export function routeFor(isEvent: boolean, fromTs: boolean, department: string): Route {
  if (fromTs) return { fromMailbox: agentConfig.sendAs, cc: [agentConfig.ccOnEveryReply], transport: "tripleseat_relay" };
  if (isEvent) return { fromMailbox: agentConfig.sendAs, cc: [agentConfig.ccOnEveryReply], transport: "email_from_events" };
  const dept = agentConfig.deptSendAs[department];
  if (dept) return { fromMailbox: dept, cc: [], transport: "email_from_department" };
  return { fromMailbox: agentConfig.generalSendAs, cc: [], transport: "email_from_info" };
}
