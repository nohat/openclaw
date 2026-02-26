import type { TrimmedMessageId } from "../message-id.js";
import { messageIdFromTrustedSource } from "../message-id.js";
import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";

/** Overrides may pass MessageSid/MessageSidFull as string; they are normalized to TrimmedMessageId. */
export type BuildTestCtxOverrides = Partial<Omit<MsgContext, "MessageSid" | "MessageSidFull">> & {
  MessageSid?: string | TrimmedMessageId;
  MessageSidFull?: string | TrimmedMessageId;
};

export function buildTestCtx(overrides: BuildTestCtxOverrides = {}): FinalizedMsgContext {
  const { MessageSid: rawSid, MessageSidFull: rawFull, ...rest } = overrides;
  const normalized: Partial<MsgContext> = { ...rest };
  if (typeof rawSid === "string") {
    normalized.MessageSid = messageIdFromTrustedSource(rawSid);
  } else if (rawSid !== undefined) {
    normalized.MessageSid = rawSid;
  }
  if (typeof rawFull === "string") {
    normalized.MessageSidFull = messageIdFromTrustedSource(rawFull);
  } else if (rawFull !== undefined) {
    normalized.MessageSidFull = rawFull;
  }
  return finalizeInboundContext({
    Body: "",
    CommandBody: "",
    CommandSource: "text",
    From: "whatsapp:+1000",
    To: "whatsapp:+2000",
    ChatType: "direct",
    Provider: "whatsapp",
    Surface: "whatsapp",
    CommandAuthorized: false,
    ...normalized,
  });
}
