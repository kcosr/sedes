import "./settings.css";
import { Search } from "lucide-react";
import { Input } from "@client/components/ui/input";

export type SettingsSearchProps = Omit<React.ComponentProps<typeof Input>, "type" | "value" | "onChange" | "aria-label"> & {
  /** The field's accessible name. */
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
};

/** The search field above an inventory list: a leading glyph in a search input. */
export function SettingsSearch({ label, value, onValueChange, placeholder = "Search…", ...props }: SettingsSearchProps): React.JSX.Element {
  return <div data-slot="settings-search"><Search aria-hidden="true" />
    <Input type="search" aria-label={label} placeholder={placeholder} value={value}
      onChange={event => onValueChange(event.currentTarget.value)} {...props} />
  </div>;
}
