const webpack = require("@nativescript/webpack");
const { resolve } = require("path");

module.exports = (env) => {
	webpack.init(env);

	if (env.ios) {
		// iOS explicitly registers its shared onboarding XML pages in
		// onboarding-register.ios.ts. Skip Android's remaining pages and
		// their Android-only service/worker dependencies.
		webpack.chainWebpack((config) => {
			const entry = config.entry('bundle');
			entry.values().forEach((value) => {
				if (value.includes('virtual-entry-typescript')) entry.delete(value);
			});
		});
	}

	// Learn how to customize:
	// https://docs.nativescript.org/webpack

	// Bundle the top-level project docs so the Settings app's About section
	// can display them (see app/ui/dashboard/settings-menus.ts).
	for (const doc of ["README.md", "LICENSE", "PRIVACY", "ACKNOWLEDGEMENTS.md"]) {
		webpack.Utils.addCopyRule({
			from: resolve(__dirname, doc),
			to: "about/",
		});
	}

	return webpack.resolveConfig();
};
