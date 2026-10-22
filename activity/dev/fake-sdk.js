// Stand-in for @discord/embedded-app-sdk in the local dev build only (build.mjs --dev). Never shipped.
// The page URL plays the Discord client: ?user=ana&guild=<id>&instance=<id>.
const params = new URLSearchParams(location.search);

export const RPCCloseCodes = Object.freeze({ CLOSE_NORMAL: 1000 });

export class DiscordSDK {
  constructor(clientId) {
    this.clientId = clientId;
    this.guildId = params.get("guild");
    this.instanceId = params.get("instance") ?? "dev-instance";
    this.channelId = "dev-channel";
    this.platform = "desktop";
    const user = (params.get("user") ?? "ana").replace(/[^A-Za-z0-9]/g, "");
    this.commands = {
      authorize: async () => ({ code: `devcode${user}` }),
      authenticate: async ({ access_token }) => ({ access_token, user: { id: "dev", username: user } }),
    };
  }

  async ready() {}

  close() { document.body.textContent = "activity closed"; }
}
