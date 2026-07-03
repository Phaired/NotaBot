// Ported from module_game.lua — cycles the bot's "Playing ..." activity.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { Timer } from "../core/timer";

export default class GameModule extends BotModule {
  name = "game";
  global = true;

  private updateTimer?: Timer;

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Array: true,
        Global: true,
        Name: "GameList",
        Description: "List of activities",
        Type: ConfigType.String,
        Default: [],
        Sensitive: true,
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    this.updateTimer = this.bot.createRepeatTimer(3 * 60, -1, () => this.updateActivity());
    this.updateActivity();
    return true;
  }

  async onUnload(): Promise<void> {
    this.updateTimer?.stop();
  }

  private updateActivity() {
    const games: string[] = this.globalConfig.GameList ?? [];
    if (games.length === 0) return;
    const newGame = games[Math.floor(Math.random() * games.length)];
    this.bot.client.user?.setActivity(String(newGame));
  }
}
