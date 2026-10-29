import type { Decorator, Preview } from "@storybook/react";
import "../src/styles/globals.css";
import { fontVariables } from "../src/app/fonts";
import { MockAppProviders } from "./mock-providers";

// Same Geist faces as the app; on <html> so portalled dialogs and sheets get them too.
document.documentElement.classList.add(...fontVariables.split(" "));

const withProviders: Decorator = (Story, context) => (
  <MockAppProviders theme={String(context.globals.theme ?? "light")}>
    <div className="bg-background p-6 text-foreground">
      <Story />
    </div>
  </MockAppProviders>
);

const preview: Preview = {
  decorators: [withProviders],
  parameters: {
    // Spec S8 widths. Phone is the default so stories are reviewed mobile first.
    viewport: {
      options: {
        phone: { name: "Phone", styles: { width: "375px", height: "812px" }, type: "mobile" },
        tablet: { name: "Tablet", styles: { width: "768px", height: "1024px" }, type: "tablet" },
        desktop: { name: "Desktop", styles: { width: "1280px", height: "800px" }, type: "desktop" },
      },
    },
  },
  initialGlobals: {
    viewport: { value: "phone", isRotated: false },
  },
  globalTypes: {
    theme: {
      description: "Color theme",
      defaultValue: "light",
      toolbar: {
        title: "Theme",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
};

export default preview;
