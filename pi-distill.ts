import { existsSync, unlinkSync } from "node:fs";

import type {
	BranchSummaryEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	SessionManager,
	SessionMessageEntry,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { SessionManager as PiSessionManager } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PREVIEW_TEXT_LIMIT = 120;
const TRANSCRIPT_TEXT_LIMIT = 600;
const MISSING_REPLAY_ID = "__distill_missing__";

type DistillCommandResult =
	| {
			kind: "submit";
			selectedIds: string[];
	  }
	| undefined;

interface DistillableEntry {
	index: number;
	entry: SessionEntry;
	rowType: string;
	rowPreview: string;
	transcriptLabel: string;
	transcriptBody: string;
	badges: string[];
}

export default function piDistillExtension(pi: ExtensionAPI) {
	pi.registerCommand("distill", {
		description: "Select entries from the active branch and carry them into a fresh distilled session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const branchEntries = ctx.sessionManager.getBranch();
			const items = branchEntries.filter(isDistillableEntry).map((entry, index) => createDistillableEntry(entry, index));

			if (items.length === 0) {
				ctx.ui.notify("No branch entries are available to carry forward.", "warning");
				return;
			}

			const result = await ctx.ui.custom<DistillCommandResult>(
				(tui, theme, _keybindings, done) => new DistillOverlayComponent(tui, theme, items, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "78%",
						minWidth: 72,
						maxHeight: "90%",
						margin: 1,
					},
				},
			);

			if (!result || result.kind !== "submit") {
				return;
			}

			const selectedEntries = items.filter((item) => result.selectedIds.includes(item.entry.id));
			if (selectedEntries.length === 0) {
				ctx.ui.notify("Select at least one entry to create a distilled session.", "warning");
				return;
			}

			await createAndSwitchToDistilledSession(ctx, selectedEntries);
		},
	});
}

class DistillOverlayComponent implements Component {
	private readonly selected: boolean[];
	private cursor = 0;
	private previewMode = false;
	private previewOffset = 0;
	private notice: { text: string; tone: "warning" | "info" } | null = null;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly items: DistillableEntry[],
		private readonly done: (result: DistillCommandResult) => void,
	) {
		this.selected = new Array(items.length).fill(true);
	}

	handleInput(data: string): void {
		if (this.previewMode) {
			this.handlePreviewInput(data);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.clearNotice();
			return;
		}

		if (matchesKey(data, "down")) {
			this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
			this.clearNotice();
			return;
		}

		if (matchesKey(data, "space")) {
			this.selected[this.cursor] = !this.selected[this.cursor];
			this.clearNotice();
			return;
		}

		if (matchesChar(data, "a")) {
			this.selected.fill(true);
			this.clearNotice();
			return;
		}

		if (matchesChar(data, "n")) {
			this.selected.fill(false);
			this.clearNotice();
			return;
		}

		if (matchesChar(data, "i")) {
			for (let i = 0; i < this.selected.length; i++) {
				this.selected[i] = !this.selected[i];
			}
			this.clearNotice();
			return;
		}

		if (matchesChar(data, "p")) {
			this.previewMode = true;
			this.previewOffset = 0;
			this.clearNotice();
			return;
		}

		if (matchesKey(data, "return")) {
			const selectedIds = this.items.filter((_, index) => this.selected[index]).map((item) => item.entry.id);
			if (selectedIds.length === 0) {
				this.notice = {
					text: "Select at least one entry to create a distilled session.",
					tone: "warning",
				};
				return;
			}

			this.done({ kind: "submit", selectedIds });
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(30, width - 2);
		const lines: string[] = [];
		const row = (content = "") => {
			const clipped = truncateToWidth(content, innerWidth);
			return `${this.theme.fg("border", "│")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${this.theme.fg("border", "│")}`;
		};

		const selectedCount = this.selected.filter(Boolean).length;
		const maxBodyLines = Math.max(8, Math.floor(this.tui.terminal.rows * 0.9) - 8 - (this.notice ? 1 : 0));

		lines.push(this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(` ${this.theme.fg("accent", "Distill session")} ${this.theme.fg("dim", `(${selectedCount}/${this.items.length} selected)`)} `));
		lines.push(
			row(
				` ${this.theme.fg("dim", this.previewMode ? "Preview of the distilled transcript. Original session remains unchanged." : "Select entries to carry forward into a new clean session. Original session remains unchanged.")}`,
			),
		);
		lines.push(
			row(
				` ${this.theme.fg("dim", this.previewMode ? "↑↓ scroll • q/esc back" : "↑↓ move • space toggle • a all • n none • i invert • p preview • enter create • esc cancel")}`,
			),
		);
		lines.push(row());

		const bodyLines = this.previewMode
			? this.renderPreviewBody(innerWidth, maxBodyLines)
			: this.renderSelectionBody(innerWidth, maxBodyLines);

		for (const bodyLine of bodyLines) {
			lines.push(row(bodyLine));
		}

		if (this.notice) {
			const color = this.notice.tone === "warning" ? "warning" : "accent";
			lines.push(row(` ${this.theme.fg(color, this.notice.text)}`));
		}

		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}

	private handlePreviewInput(data: string): void {
		const previewLines = this.buildPreviewLines();
		const maxBodyLines = Math.max(8, Math.floor(this.tui.terminal.rows * 0.9) - 8 - (this.notice ? 1 : 0));
		const maxOffset = Math.max(0, previewLines.length - maxBodyLines);

		if (matchesKey(data, "escape") || matchesChar(data, "q") || matchesChar(data, "p")) {
			this.previewMode = false;
			this.previewOffset = 0;
			return;
		}

		if (matchesKey(data, "up")) {
			this.previewOffset = Math.max(0, this.previewOffset - 1);
			return;
		}

		if (matchesKey(data, "down")) {
			this.previewOffset = Math.min(maxOffset, this.previewOffset + 1);
		}
	}

	private renderSelectionBody(innerWidth: number, maxBodyLines: number): string[] {
		const start = calculateWindowStart(this.cursor, this.items.length, maxBodyLines);
		const end = Math.min(this.items.length, start + maxBodyLines);
		const lines: string[] = [];

		for (let i = start; i < end; i++) {
			const item = this.items[i]!;
			const isSelectedRow = i === this.cursor;
			const included = this.selected[i];
			const marker = included ? "[x]" : "[ ]";
			const cursor = isSelectedRow ? this.theme.fg("accent", "›") : " ";
			const index = String(item.index + 1).padStart(2, "0");
			const badgeText = item.badges.length > 0 ? ` ${this.theme.fg("dim", item.badges.map((badge) => `[${badge}]`).join(" "))}` : "";
			const base = `${cursor} ${marker} ${index} ${item.rowType} ${quotePreview(item.rowPreview)}${badgeText}`;
			lines.push(isSelectedRow ? this.theme.fg("accent", truncateToWidth(base, innerWidth)) : truncateToWidth(base, innerWidth));
		}

		while (lines.length < maxBodyLines) {
			lines.push("");
		}

		return lines;
	}

	private renderPreviewBody(innerWidth: number, maxBodyLines: number): string[] {
		const previewLines = this.buildPreviewLines();
		const start = Math.min(this.previewOffset, Math.max(0, previewLines.length - maxBodyLines));
		const end = Math.min(previewLines.length, start + maxBodyLines);
		const lines = previewLines.slice(start, end);

		while (lines.length < maxBodyLines) {
			lines.push("");
		}

		return lines.map((line) => truncateToWidth(line, innerWidth));
	}

	private buildPreviewLines(): string[] {
		const selectedItems = this.items.filter((_, index) => this.selected[index]);
		if (selectedItems.length === 0) {
			return [this.theme.fg("warning", "No entries selected yet.")];
		}

		const innerWidth = Math.max(24, Math.floor(this.tui.terminal.columns * 0.78) - 4);
		const lines: string[] = [];

		for (const item of selectedItems) {
			const prefix = `${item.transcriptLabel}: `;
			const wrapped = wrapPlainText(item.transcriptBody || "<empty>", Math.max(10, innerWidth - prefix.length));

			if (wrapped.length === 0) {
				lines.push(`${this.theme.fg("accent", prefix)}<empty>`);
			} else {
				lines.push(`${this.theme.fg("accent", prefix)}${wrapped[0]}`);
				for (let i = 1; i < wrapped.length; i++) {
					lines.push(`${" ".repeat(prefix.length)}${wrapped[i]}`);
				}
			}

			lines.push("");
		}

		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		return lines;
	}

	private clearNotice(): void {
		this.notice = null;
	}
}

async function createAndSwitchToDistilledSession(ctx: ExtensionCommandContext, items: DistillableEntry[]): Promise<void> {
	const targetSession = PiSessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
	const sessionPath = targetSession.getSessionFile();

	if (!sessionPath) {
		throw new Error("Failed to allocate a persisted distilled session file.");
	}

	const replayedIds = new Map<string, string>();
	const name = getDistilledSessionName(ctx.sessionManager.getSessionName());
	let switched = false;

	try {
		targetSession.appendSessionInfo(name);

		for (const item of items) {
			const newId = replayEntry(targetSession, item.entry, replayedIds);
			replayedIds.set(item.entry.id, newId);
		}

		// Force the complete session to disk before switching. Pi normally delays
		// persistence until an assistant message appears, which would make
		// distilled sessions built from user-only selections impossible to open.
		(targetSession as unknown as { _rewriteFile(): void })._rewriteFile();

		const switchResult = await ctx.switchSession(sessionPath);
		if (switchResult.cancelled) {
			cleanupSessionFile(sessionPath);
			ctx.ui.notify("Distilled session creation was cancelled before switching.", "warning");
			return;
		}

		switched = true;
		ctx.ui.notify(`Created distilled session from ${items.length} selected entr${items.length === 1 ? "y" : "ies"} and switched to it.`, "info");
	} catch (error) {
		if (!switched) {
			cleanupSessionFile(sessionPath);
		}
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to create distilled session: ${message}`, "error");
	}
}

function replayEntry(target: SessionManager, entry: SessionEntry, replayedIds: Map<string, string>): string {
	switch (entry.type) {
		case "message":
			return replayMessageEntry(target, entry);
		case "custom_message":
			return target.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
		case "compaction": {
			const firstKeptEntryId = replayedIds.get(entry.firstKeptEntryId) ?? MISSING_REPLAY_ID;
			return target.appendCompaction(entry.summary, firstKeptEntryId, entry.tokensBefore, entry.details, entry.fromHook);
		}
		case "branch_summary": {
			const branchParentId = target.getLeafId();
			const newId = target.branchWithSummary(branchParentId, entry.summary, entry.details, entry.fromHook);
			const appendedEntry = target.getEntry(newId) as BranchSummaryEntry | undefined;
			if (appendedEntry) {
				appendedEntry.fromId = replayedIds.get(entry.fromId) ?? "distilled-source";
			}
			return newId;
		}
		case "model_change":
			return target.appendModelChange(entry.provider, entry.modelId);
		case "thinking_level_change":
			return target.appendThinkingLevelChange(entry.thinkingLevel);
		default:
			throw new Error(`Unsupported distill entry type: ${entry.type}`);
	}
}

function replayMessageEntry(target: SessionManager, entry: SessionMessageEntry): string {
	const role = entry.message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") {
		throw new Error(`Unsupported distill message role: ${role}`);
	}

	return target.appendMessage(entry.message);
}

function isDistillableEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") {
		return entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult" || entry.message.role === "custom";
	}

	return (
		entry.type === "custom_message" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		entry.type === "model_change" ||
		entry.type === "thinking_level_change"
	);
}

function createDistillableEntry(entry: SessionEntry, index: number): DistillableEntry {
	return {
		index,
		entry,
		rowType: getRowType(entry),
		rowPreview: getRowPreview(entry),
		transcriptLabel: getTranscriptLabel(entry),
		transcriptBody: getTranscriptBody(entry),
		badges: getBadges(entry),
	};
}

function getRowType(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return entry.message.role;
		case "custom_message":
			return "custom";
		case "branch_summary":
			return "branchSummary";
		case "compaction":
			return "compaction";
		case "model_change":
			return "modelChange";
		case "thinking_level_change":
			return "thinkingChange";
		default:
			return entry.type;
	}
}

function getRowPreview(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return getMessagePreview(entry);
		case "custom_message":
			return limitText(firstMeaningfulLine(extractText(entry.content)) || "<custom message>", PREVIEW_TEXT_LIMIT);
		case "compaction":
			return limitText(firstMeaningfulLine(entry.summary) || "<compaction>", PREVIEW_TEXT_LIMIT);
		case "branch_summary":
			return limitText(firstMeaningfulLine(entry.summary) || "<branch summary>", PREVIEW_TEXT_LIMIT);
		case "model_change":
			return `${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return entry.thinkingLevel;
		default:
			return "<entry>";
	}
}

function getTranscriptLabel(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult") {
				return `toolResult(${entry.message.toolName})`;
			}
			if (entry.message.role === "custom") {
				return `custom(${entry.message.customType})`;
			}
			return entry.message.role;
		case "custom_message":
			return `custom(${entry.customType})`;
		case "branch_summary":
			return "branchSummary";
		case "compaction":
			return "compaction";
		case "model_change":
			return "modelChange";
		case "thinking_level_change":
			return "thinkingLevel";
		default:
			return entry.type;
	}
}

function getTranscriptBody(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return getMessageTranscript(entry);
		case "custom_message":
			return limitText(extractText(entry.content) || "<custom message>", TRANSCRIPT_TEXT_LIMIT);
		case "compaction":
			return limitText(entry.summary || "<compaction>", TRANSCRIPT_TEXT_LIMIT);
		case "branch_summary":
			return limitText(entry.summary || "<branch summary>", TRANSCRIPT_TEXT_LIMIT);
		case "model_change":
			return `${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return entry.thinkingLevel;
		default:
			return "<entry>";
	}
}

function getBadges(entry: SessionEntry): string[] {
	const badges: string[] = [];

	if (entry.type === "message") {
		if (entry.message.role === "assistant" && hasToolCalls(entry.message.content)) {
			badges.push("tools");
		}
		if (entry.message.role === "assistant" && (entry.message.stopReason === "error" || entry.message.stopReason === "aborted")) {
			badges.push("error");
		}
		if (entry.message.role === "toolResult" && entry.message.isError) {
			badges.push("error");
		}
		if (entry.message.role === "custom") {
			badges.push("custom");
		}
		if (getMessagePreview(entry).length >= PREVIEW_TEXT_LIMIT) {
			badges.push("long");
		}
	}

	if (entry.type === "custom_message") {
		badges.push("custom");
		if (extractText(entry.content).length >= PREVIEW_TEXT_LIMIT) {
			badges.push("long");
		}
	}

	if (entry.type === "compaction" || entry.type === "branch_summary") {
		badges.push("summary");
	}

	if (entry.type === "model_change") {
		badges.push("model");
	}

	if (entry.type === "thinking_level_change") {
		badges.push("thinking");
	}

	return badges;
}

function getMessagePreview(entry: SessionMessageEntry): string {
	const message = entry.message;

	switch (message.role) {
		case "user":
			return limitText(firstMeaningfulLine(extractText(message.content)) || "<user message>", PREVIEW_TEXT_LIMIT);
		case "assistant": {
			const text = firstMeaningfulLine(extractFirstAssistantText(message.content) || summarizeToolCalls(message.content) || "<assistant message>");
			return limitText(text || "<assistant message>", PREVIEW_TEXT_LIMIT);
		}
		case "toolResult": {
			const preview = firstMeaningfulLine(extractText(message.content)) || `<${message.toolName} result>`;
			return limitText(`${message.toolName}: ${preview}`, PREVIEW_TEXT_LIMIT);
		}
		case "custom":
			return limitText(firstMeaningfulLine(extractText(message.content)) || "<custom message>", PREVIEW_TEXT_LIMIT);
		default:
			return "<message>";
	}
}

function getMessageTranscript(entry: SessionMessageEntry): string {
	const message = entry.message;

	switch (message.role) {
		case "user":
			return limitText(extractText(message.content) || "<user message>", TRANSCRIPT_TEXT_LIMIT);
		case "assistant":
			return limitText(extractFirstAssistantText(message.content) || summarizeToolCalls(message.content) || "<assistant message>", TRANSCRIPT_TEXT_LIMIT);
		case "toolResult": {
			const text = extractText(message.content);
			return limitText(text ? `${message.toolName}: ${text}` : `${message.toolName}: <tool result>`, TRANSCRIPT_TEXT_LIMIT);
		}
		case "custom":
			return limitText(extractText(message.content) || "<custom message>", TRANSCRIPT_TEXT_LIMIT);
		default:
			return "<message>";
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function extractFirstAssistantText(content: unknown): string | undefined {
	if (!Array.isArray(content)) {
		return undefined;
	}

	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			return block.text;
		}
	}

	return undefined;
}

function summarizeToolCalls(content: unknown): string | undefined {
	if (!Array.isArray(content)) {
		return undefined;
	}

	const names = content
		.filter((block): block is { type: "toolCall"; name: string } => isRecord(block) && block.type === "toolCall" && typeof block.name === "string")
		.map((block) => block.name);

	if (names.length === 0) {
		return undefined;
	}

	const unique = [...new Set(names)];
	return unique.length === 1 ? `tool call: ${unique[0]}` : `tool calls: ${unique.join(", ")}`;
}

function hasToolCalls(content: unknown): boolean {
	return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "toolCall");
}

function firstMeaningfulLine(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) {
			return trimmed;
		}
	}

	return text.trim();
}

function limitText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function quotePreview(text: string): string {
	return text.startsWith("<") ? text : `"${text}"`;
}

function wrapPlainText(text: string, width: number): string[] {
	const maxWidth = Math.max(8, width);
	const paragraphs = text.split(/\r?\n/);
	const lines: string[] = [];

	for (const paragraph of paragraphs) {
		const source = paragraph.trim();
		if (!source) {
			lines.push("");
			continue;
		}

		let current = "";
		for (const word of source.split(/\s+/)) {
			if (!current) {
				current = word;
				continue;
			}

			if (current.length + 1 + word.length <= maxWidth) {
				current += ` ${word}`;
			} else {
				lines.push(current);
				current = word;
			}
		}

		if (current) {
			lines.push(current);
		}
	}

	return lines;
}

function calculateWindowStart(cursor: number, total: number, visible: number): number {
	if (total <= visible) {
		return 0;
	}

	return Math.max(0, Math.min(cursor - Math.floor(visible / 2), total - visible));
}

function matchesChar(data: string, char: string): boolean {
	return data === char || data === char.toUpperCase();
}

function getDistilledSessionName(existingName: string | undefined): string {
	if (existingName?.trim()) {
		return `Distilled from ${existingName.trim()}`;
	}

	return `Distilled session ${new Date().toISOString().replace("T", " ").slice(0, 16)}`;
}

function cleanupSessionFile(sessionPath: string): void {
	if (existsSync(sessionPath)) {
		unlinkSync(sessionPath);
	}
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
