"use strict";
/**
 * Which mailbox a reply leaves from.
 *
 * - Event conversations: events@, on the Tripleseat thread or by email, with events@ copied.
 * - Solstice, Bodega and yoga questions: the department's own address (solstice@, bodega@, yoga@).
 * - Anything else: info@.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeFor = routeFor;
const config_js_1 = require("./config.js");
function routeFor(isEvent, fromTs, department) {
    if (fromTs)
        return { fromMailbox: config_js_1.agentConfig.sendAs, cc: [config_js_1.agentConfig.ccOnEveryReply], transport: "tripleseat_relay" };
    if (isEvent)
        return { fromMailbox: config_js_1.agentConfig.sendAs, cc: [config_js_1.agentConfig.ccOnEveryReply], transport: "email_from_events" };
    const dept = config_js_1.agentConfig.deptSendAs[department];
    if (dept)
        return { fromMailbox: dept, cc: [], transport: "email_from_department" };
    return { fromMailbox: config_js_1.agentConfig.generalSendAs, cc: [], transport: "email_from_info" };
}
