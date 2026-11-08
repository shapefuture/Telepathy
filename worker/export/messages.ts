// Convert mtcute's rich messages into stable, JSON-safe values. In particular, do not dump raw
// Telegram objects: they contain access hashes and Long values which are neither needed nor safe
// in a portable chat archive. Field names follow Telegram Desktop's single-chat JSON schema where
// possible, while `media`, `entities`, `sender` and `topic_id` retain useful Telepathy extensions.

import type { Message, tl } from "@mtcute/web";
import type { ExportMessage, ExportTextEntity, LeanExportMessage } from "./archive";

const NOT_INCLUDED = "(File not included. Change data exporting settings to download.)";

function entityType(raw: tl.TypeMessageEntity): string {
  const name = raw._.replace(/^messageEntity/, "");
  const special: Record<string, string> = { TextUrl: "text_link", MentionName: "mention_name", Phone: "phone", CustomEmoji: "custom_emoji" };
  return special[name] ?? name.replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase();
}

function officialEntity(e: Message["entities"][number]): ExportTextEntity {
  return {
    type: entityType(e.raw),
    text: e.text,
    ...(e.raw._ === "messageEntityTextUrl" ? { url: e.raw.url } : {}),
    ...(e.raw._ === "messageEntityPre" && e.raw.language ? { language: e.raw.language } : {}),
  };
}

function mediaOf(raw: tl.RawMessage | tl.RawMessageService): { media: Record<string, unknown> | null; compatible: Partial<ExportMessage> } {
  if (raw._ !== "message" || !raw.media) return { media: null, compatible: {} };
  const rawMedia = raw.media;
  const media: Record<string, unknown> = { type: rawMedia._.replace(/^messageMedia/, "").replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase() };
  const compatible: Partial<ExportMessage> = {};
  if (rawMedia._ === "messageMediaPhoto" && rawMedia.photo?._ === "photo") {
    const sizes = rawMedia.photo.sizes.filter((s) => s._ === "photoSize");
    const largest = sizes.sort((a, b) => a.w * a.h - b.w * b.h).at(-1);
    Object.assign(media, { size: Math.max(0, ...sizes.map((s) => s.size)) });
    Object.assign(compatible, { photo: NOT_INCLUDED, width: largest?.w, height: largest?.h });
  }
  if (rawMedia._ === "messageMediaDocument" && rawMedia.document?._ === "document") {
    const doc = rawMedia.document;
    const attrs = doc.attributes;
    const filename = attrs.find((a) => a._ === "documentAttributeFilename");
    const audio = attrs.find((a) => a._ === "documentAttributeAudio");
    const video = attrs.find((a) => a._ === "documentAttributeVideo");
    const sticker = attrs.find((a) => a._ === "documentAttributeSticker");
    const image = attrs.find((a) => a._ === "documentAttributeImageSize");
    const animated = attrs.some((a) => a._ === "documentAttributeAnimated");
    const mediaType = audio?._ === "documentAttributeAudio" ? (audio.voice ? "voice_message" : "audio_file") : sticker ? "sticker" : video?._ === "documentAttributeVideo" ? (video.roundMessage ? "video_message" : "video_file") : animated ? "animation" : undefined;
    Object.assign(media, { mime_type: doc.mimeType, size: doc.size.toString(), media_type: mediaType ?? "document" });
    Object.assign(compatible, { file: NOT_INCLUDED, mime_type: doc.mimeType, file_size: Number(doc.size.toString()), ...(mediaType ? { media_type: mediaType } : {}) });
    if (filename?._ === "documentAttributeFilename") Object.assign(media, { file_name: filename.fileName }), (compatible.file_name = filename.fileName);
    if (audio?._ === "documentAttributeAudio") {
      Object.assign(media, { duration: audio.duration, title: audio.title, performer: audio.performer });
      Object.assign(compatible, { duration_seconds: audio.duration, title: audio.title, performer: audio.performer });
    }
    if (video?._ === "documentAttributeVideo") {
      Object.assign(media, { duration: video.duration, width: video.w, height: video.h });
      Object.assign(compatible, { duration_seconds: video.duration, width: video.w, height: video.h });
    }
    if (image?._ === "documentAttributeImageSize") Object.assign(compatible, { width: image.w, height: image.h });
    if (sticker?._ === "documentAttributeSticker") Object.assign(media, { sticker_emoji: sticker.alt }), (compatible.sticker_emoji = sticker.alt);
  }
  if (rawMedia._ === "messageMediaPoll") {
    const poll = {
      question: rawMedia.poll.question.text,
      closed: rawMedia.poll.closed,
      total_voters: rawMedia.results.totalVoters,
      answers: rawMedia.poll.answers.map((a, i) => ({ text: a.text.text, voters: rawMedia.results.results?.[i]?.voters ?? 0, chosen: rawMedia.results.results?.[i]?.chosen ?? false })),
    };
    media.poll = poll;
    compatible.poll = poll;
  }
  if (rawMedia._ === "messageMediaVenue" || rawMedia._ === "messageMediaGeo" || rawMedia._ === "messageMediaGeoLive") {
    const location: Record<string, unknown> = rawMedia.geo._ === "geoPoint" ? { latitude: rawMedia.geo.lat, longitude: rawMedia.geo.long } : {};
    if (rawMedia._ === "messageMediaVenue") Object.assign(location, { title: rawMedia.title, address: rawMedia.address });
    media.location = location;
    compatible.location_information = location;
  }
  if (rawMedia._ === "messageMediaContact") {
    const contact = { first_name: rawMedia.firstName, last_name: rawMedia.lastName, phone_number: rawMedia.phoneNumber };
    media.contact = contact;
    compatible.contact_information = contact;
  }
  return { media, compatible };
}

/** Minimal user-message shape for the lean prefilter. Optional references are emitted only when
 * present, so consumers can follow reply and forward chains without carrying unrelated metadata. */
export function exportLeanMessage(m: Message): LeanExportMessage {
  const sender = m.sender;
  const raw = m.raw;
  const reply = raw._ === "message" && raw.replyTo?._ === "messageReplyHeader" ? raw.replyTo : null;
  const fromKind = sender?.type === "user" ? "user" : sender && "chatType" in sender && sender.chatType === "group" ? "chat" : "channel";
  return {
    id: m.id,
    date: m.date.toISOString(),
    text: m.text,
    ...(sender ? { from: sender.displayName, from_id: `${fromKind}${Math.abs(sender.id)}` } : {}),
    ...(sender && "username" in sender && sender.username ? { from_username: sender.username } : {}),
    ...(reply ? { reply_to_message_id: reply.replyToMsgId } : {}),
    ...(m.forward?.sender.displayName ? { forwarded_from: m.forward.sender.displayName } : {}),
    ...(reply?.forumTopic ? { topic_id: reply.replyToTopId ?? reply.replyToMsgId } : {}),
  };
}

export function exportMessage(m: Message): ExportMessage {
  const sender = m.sender;
  const raw = m.raw;
  const isService = raw._ === "messageService";
  const reply = raw._ === "message" && raw.replyTo?._ === "messageReplyHeader" ? raw.replyTo : null;
  const senderOut = sender
    ? { id: sender.id, type: sender.type, name: sender.displayName, ...("username" in sender && sender.username ? { username: sender.username } : {}) }
    : null;
  const fromKind = sender?.type === "user" ? "user" : sender && "chatType" in sender && sender.chatType === "group" ? "chat" : "channel";
  const fromId = sender ? `${fromKind}${Math.abs(sender.id)}` : undefined;
  const { media, compatible } = mediaOf(raw);
  const reactions = m.reactions?.reactions.map((r) =>
    typeof r.emoji === "string" ? { type: "emoji" as const, emoji: r.emoji, count: r.count } : { type: "custom_emoji" as const, document_id: r.emoji.toString(), count: r.count },
  );
  return {
    id: m.id,
    type: isService ? "service" : "message",
    date: m.date.toISOString(),
    date_unixtime: String(Math.floor(m.date.getTime() / 1000)),
    edit_date: m.editDate?.toISOString() ?? null,
    ...(m.editDate ? { edited: m.editDate.toISOString(), edited_unixtime: String(Math.floor(m.editDate.getTime() / 1000)) } : {}),
    text: m.text,
    text_entities: m.entities.map(officialEntity),
    ...(senderOut && !isService ? { from: senderOut.name, from_id: fromId } : {}),
    ...(senderOut && isService ? { actor: senderOut.name, actor_id: fromId } : {}),
    sender: senderOut,
    outgoing: m.isOutgoing,
    reply_to_message_id: reply?.replyToMsgId ?? null,
    ...(m.forward?.sender.displayName ? { forwarded_from: m.forward.sender.displayName } : {}),
    topic_id: reply?.forumTopic ? (reply.replyToTopId ?? reply.replyToMsgId ?? null) : null,
    ...(m.groupedIdUnique ? { grouped_id: m.groupedIdUnique } : {}),
    ...(m.viaBot ? { via_bot: m.viaBot.displayName } : {}),
    service: isService ? raw.action._ : null,
    ...(isService ? { action: raw.action._ } : {}),
    media,
    entities: m.entities.map((e) => ({ type: e.raw._, offset: e.raw.offset, length: e.raw.length, ...(e.raw._ === "messageEntityTextUrl" ? { url: e.raw.url } : {}) })),
    ...(reactions?.length ? { reactions } : {}),
    ...compatible,
  };
}
