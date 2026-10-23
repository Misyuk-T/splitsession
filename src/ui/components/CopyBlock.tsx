import { useState } from "preact/hooks";

import { Button } from "./Button";

/** A command on its own line with a Copy button (the command stays selectable if the clipboard is blocked). */
export const CopyBlock = ({
  text,
  copyable = true,
  testId,
}: {
  text: string;
  copyable?: boolean;
  testId?: string;
}) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div class="fx-bridge__cmd" data-testid={testId}>
      <code>{text}</code>
      {copyable && (
        <Button small onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      )}
    </div>
  );
};
