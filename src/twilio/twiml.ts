import type { IvrCommand } from "../ivr/stateMachine";

export type TwimlOptions = {
  gatherAction: string;
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderCommand(command: IvrCommand, opts: TwimlOptions): string {
  switch (command.type) {
    case "ANSWER":
      return "";
    case "SPEAK":
      return `<Say>${escapeXml(command.text)}</Say>`;
    case "GATHER":
      return (
        `<Gather action="${opts.gatherAction}" method="POST" input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true">` +
        `<Say>${escapeXml(command.prompt)}</Say>` +
        `</Gather>`
      );
    case "HANGUP":
      return "<Hangup/>";
  }
}

export function renderTwiml(commands: IvrCommand[], opts: TwimlOptions): string {
  const body = commands.map((command) => renderCommand(command, opts)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}
