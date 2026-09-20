// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendInteraction } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { InteractionPrompt } from "./InteractionPrompt.js";

type FormInteraction = Extract<BackendInteraction, { kind: "form" }>;

function request(): FormInteraction {
  return {
    id: "form-one",
    threadId: "thread-one",
    kind: "form",
    sourceLabel: { text: "Agent" },
    title: { text: "Search details" },
    openedAt: "2026-09-19T15:00:00.000Z",
    secret: false,
    destructive: false,
    cancellable: true,
    fields: [
      {
        id: "project",
        label: { text: "Project" },
        required: true,
        description: { text: "At least two characters." },
        input: { kind: "text", minLength: 2 },
      },
      {
        id: "limit",
        label: { text: "Result limit" },
        required: true,
        input: {
          kind: "number",
          integer: true,
          minimum: 0,
          maximum: 50,
          default: 0,
        },
      },
      {
        id: "archived",
        label: { text: "Include archived" },
        required: false,
        input: { kind: "boolean", default: false },
      },
      {
        id: "region",
        label: { text: "Region" },
        required: false,
        input: {
          kind: "single_choice",
          default: "region-us",
          options: [
            { id: "region-us", label: { text: "US" } },
            { id: "region-eu", label: { text: "EU" } },
          ],
        },
      },
      {
        id: "sources",
        label: { text: "Sources" },
        required: false,
        input: {
          kind: "multiple_choice",
          default: ["source-local"],
          minItems: 1,
          maxItems: 2,
          options: [
            { id: "source-local", label: { text: "Local" } },
            { id: "source-hosted", label: { text: "Hosted" } },
          ],
        },
      },
      {
        id: "note",
        label: { text: "Optional note" },
        required: false,
        input: { kind: "text" },
      },
    ],
  };
}

function mount(
  current = request(),
  respond = vi.fn().mockResolvedValue(undefined),
) {
  return {
    respond,
    ...render(
      <InteractionPrompt
        request={current}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    ),
  };
}

afterEach(cleanup);

describe("InteractionForm", () => {
  it("names optional controls using their visible label and describes required choice errors", () => {
    const form = request();
    const sources = form.fields.find((field) => field.id === "sources")!;
    form.fields = [{ ...sources, required: true }];
    mount(form);
    const group = screen.getByRole("group", { name: "Sources (required)" });
    expect(group).not.toHaveAttribute("aria-required");
    expect(group).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByRole("checkbox", { name: "Local" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const error = screen.getByRole("alert");
    expect(group.getAttribute("aria-describedby")?.split(" ")).toContain(
      error.id,
    );
    expect(group).toHaveFocus();
    cleanup();
    mount();
    expect(
      screen
        .getByRole("checkbox", {
          name: "Include optional field Optional note",
        })
        .closest("label"),
    ).toHaveTextContent("Include optional field");
  });

  it("preserves false and zero defaults, uses opaque choices, and omits unanswered optional fields", async () => {
    const { respond } = mount();
    expect(
      screen.getByRole("spinbutton", { name: "Result limit" }),
    ).toHaveValue(0);
    expect(
      screen.getByRole("combobox", { name: "Include archived" }),
    ).toHaveValue("false");
    expect(
      screen.getByRole("textbox", { name: "Optional note" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Project" }), {
      target: { value: "Docs" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Region" }), {
      target: { value: "region-eu" },
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Sources" })).getByRole(
        "checkbox",
        { name: "Hosted" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenCalledExactlyOnceWith("form-one", {
      kind: "form",
      answers: [
        { fieldId: "project", value: "Docs" },
        { fieldId: "limit", value: 0 },
        { fieldId: "archived", value: false },
        { fieldId: "region", value: "region-eu" },
        { fieldId: "sources", value: ["source-local", "source-hosted"] },
      ],
    });
  });

  it("validates required fields and bounds before submitting, and retains values after backend rejection", async () => {
    const respond = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("The request changed; review and try again."),
      )
      .mockResolvedValue(undefined);
    mount(request(), respond);
    fireEvent.change(screen.getByRole("textbox", { name: "Project" }), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Result limit" }), {
      target: { value: "1.5" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Local" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(screen.getByRole("textbox", { name: "Project" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Project" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Project" }), {
      target: { value: "Docs" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Result limit" }), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hosted" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("The request changed; review and try again.");
    expect(screen.getByRole("textbox", { name: "Project" })).toHaveValue(
      "Docs",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Result limit" }),
    ).toHaveValue(20);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("distinguishes explicitly included empty text from omission and permits required empty text without minLength", () => {
    const form = request();
    form.fields = [
      {
        id: "required",
        label: { text: "Required text" },
        required: true,
        input: { kind: "text" },
      },
      {
        id: "optional",
        label: { text: "Optional text" },
        required: false,
        input: { kind: "text" },
      },
    ];
    const { respond } = mount(form);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Include optional field Optional text",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenCalledExactlyOnceWith("form-one", {
      kind: "form",
      answers: [
        { fieldId: "required", value: "" },
        { fieldId: "optional", value: "" },
      ],
    });
  });

  it("validates formats and requires an explicit boolean and choice when no default exists", () => {
    const form = request();
    form.fields = [
      {
        id: "email",
        label: { text: "Email" },
        required: true,
        input: { kind: "text", format: "email" },
      },
      {
        id: "choice",
        label: { text: "Region" },
        required: true,
        input: {
          kind: "single_choice",
          options: [{ id: "one", label: { text: "One" } }],
        },
      },
      {
        id: "bool",
        label: { text: "Proceed" },
        required: true,
        input: { kind: "boolean" },
      },
    ];
    const { respond } = mount(form);
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert")).toHaveLength(3);
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "person@example.test" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Region" }), {
      target: { value: "one" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Proceed" }), {
      target: { value: "false" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenCalledOnce();
  });

  it("resets fields for the next request and keeps invocation parameters readonly", () => {
    const form = request();
    form.invocation = {
      arguments: {
        kind: "object",
        entries: [{ key: { text: "query" }, value: { text: "Fixed input" } }],
      },
    };
    const { respond, rerender } = mount(form);
    expect(
      within(
        screen.getByRole("region", { name: "Invocation parameters" }),
      ).queryByRole("textbox"),
    ).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Project" }), {
      target: { value: "Draft" },
    });
    rerender(
      <InteractionPrompt
        request={{ ...request(), id: "form-two" }}
        store={{ respond } as unknown as ThreadClientStore}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Project" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(respond).toHaveBeenCalledExactlyOnceWith("form-two", {
      kind: "cancel",
    });
  });
});
