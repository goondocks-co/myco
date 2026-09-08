# Myco

Your project's memory: the sessions that happened, the durable observations drawn from them, and the plans. Skills and tools for reading why the code is the way it is, and for recording what you learn.

## What this plugin carries

Skills, and one MCP entry pointing at your Myco deployment. That is the whole of it.

It carries **no binary and no hooks**. A hook command is the absolute path of the `myco` binary on your own machine, resolved when that binary is installed, so a downloadable bundle has neither the binary nor the path it will live at. Sessions are therefore not captured by the plugin alone.

Installing the binary as well adds session capture, plan capture, import and the worker. The **myco-setup** skill in this bundle walks through it.

## Configuring it

Your client asks for two values the first time it loads the plugin:

- **Deployment URL** — The base URL of your team's Myco deployment, for example https://myco.example.com
- **Access key** — A project access key from your deployment dashboard. It reaches one project and expires.

## What the access key costs

- It reaches one project. Working across several means one key, and one plugin configuration, per project.
- It expires. Ninety days by default, and up to a year if your administrator sets a longer window. When it lapses the tools stop answering and a new key has to be pasted in.
- Only a deployment administrator can mint one. It comes from the deployment dashboard; the plugin cannot request its own.

Installing the binary replaces the key with a credential of your own, which is the other reason to finish setup.

## License

Apache-2.0. https://myco.sh
