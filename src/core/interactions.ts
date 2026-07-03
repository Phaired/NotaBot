// Router for component (button / select menu), modal (form) and autocomplete
// interactions. Modules register handlers keyed by a custom_id prefix in their
// onLoaded(), e.g.:
//
//   this.bot.interactions.registerComponent("poll_vote_", (interaction) => { ... });
//   this.bot.interactions.registerModal("modmail_reply_", (interaction) => { ... });
//   this.bot.interactions.registerAutocomplete("tag", (interaction) => { ... });

import {
  type Interaction,
  type ButtonInteraction,
  type AnySelectMenuInteraction,
  type ModalSubmitInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import { logger } from "./logger";

type ComponentHandler = (interaction: ButtonInteraction | AnySelectMenuInteraction) => any;
type ModalHandler = (interaction: ModalSubmitInteraction) => any;
type AutocompleteHandler = (interaction: AutocompleteInteraction) => any;

interface PrefixEntry<T> {
  prefix: string;
  handler: T;
}

export class InteractionRouter {
  private components: PrefixEntry<ComponentHandler>[] = [];
  private modals: PrefixEntry<ModalHandler>[] = [];
  private autocompletes = new Map<string, AutocompleteHandler>();

  registerComponent(prefix: string, handler: ComponentHandler) {
    this.components.push({ prefix, handler });
  }
  registerModal(prefix: string, handler: ModalHandler) {
    this.modals.push({ prefix, handler });
  }
  /** Keyed by command name. */
  registerAutocomplete(commandName: string, handler: AutocompleteHandler) {
    this.autocompletes.set(commandName.toLowerCase(), handler);
  }

  /** Returns true if the interaction was handled here (component/modal/autocomplete). */
  async route(interaction: Interaction): Promise<boolean> {
    try {
      if (interaction.isButton() || interaction.isAnySelectMenu()) {
        const entry = this.components.find((e) => interaction.customId.startsWith(e.prefix));
        if (entry) {
          await entry.handler(interaction);
          return true;
        }
      } else if (interaction.isModalSubmit()) {
        const entry = this.modals.find((e) => interaction.customId.startsWith(e.prefix));
        if (entry) {
          await entry.handler(interaction);
          return true;
        }
      } else if (interaction.isAutocomplete()) {
        const handler = this.autocompletes.get(interaction.commandName.toLowerCase());
        if (handler) {
          await handler(interaction);
          return true;
        }
      }
    } catch (e: any) {
      logger.error("Interaction handler failed: %s", e?.stack ?? e);
    }
    return false;
  }
}
