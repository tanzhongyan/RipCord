import type { Meta, StoryObj } from "@storybook/react";
import { tokens } from "~/shared/config/tokens";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

function TokenSwatches() {
  return (
    <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
      {Object.entries(tokens).map(([name, values]) => (
        <Card key={name}>
          <CardHeader>
            <CardTitle className="text-sm">--{name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="size-6 rounded border" style={{ backgroundColor: values.light }} />
              <code>{values.light}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="size-6 rounded border" style={{ backgroundColor: values.dark }} />
              <code>{values.dark}</code>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const meta: Meta<typeof TokenSwatches> = {
  title: "Brand/Tokens",
  component: TokenSwatches,
};

export default meta;
type Story = StoryObj<typeof TokenSwatches>;

export const All: Story = {};
