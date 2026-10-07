import { RadioGroupItem } from "@client/components/ui/radio-group";

/**
 * One option in an editor radio list: the radio, a title and a quieter
 * description under it. The whole row is its label.
 */
export function AutomationChoice({
  value,
  title,
  description,
  disabled = false,
}: {
  readonly value: string;
  readonly title: string;
  readonly description: string;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <label className="automation-choice" data-disabled={disabled || undefined}>
      <RadioGroupItem value={value} disabled={disabled} />
      <span className="automation-choice-title">{title}</span>
      <span className="automation-choice-description">{description}</span>
    </label>
  );
}
