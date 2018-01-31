import * as path from "path";
import { EOL } from "os";
import marked = require("marked");
import { ExtensibilityService } from "../../services/extensibility-service";
import { PACKAGE_JSON_FILE_NAME } from "../../constants";

export class HelpService implements IHelpService {
	private static MARKDOWN_FILE_EXTENSION = ".md";
	private static HTML_FILE_EXTENSION = ".html";
	private static MAN_PAGE_NAME_REGEX = /@MAN_PAGE_NAME@/g;
	private static HTML_COMMAND_HELP_REGEX = /@HTML_COMMAND_HELP@/g;
	private static RELATIVE_PATH_TO_STYLES_CSS_REGEX = /@RELATIVE_PATH_TO_STYLES_CSS@/g;
	private static RELATIVE_PATH_TO_IMAGES_REGEX = /@RELATIVE_PATH_TO_IMAGES@/g;
	private static RELATIVE_PATH_TO_INDEX_REGEX = /@RELATIVE_PATH_TO_INDEX@/g;
	private static MARKDOWN_LINK_REGEX = /\[([\w \-\`\<\>\*\:\\]+?)\]\([\s\S]+?\)/g;
	private static SPAN_REGEX = /([\s\S]*?)(?:\r?\n)?<span.*?>([\s\S]*?)<\/span>(?:\r?\n)*/g;
	private static NEW_LINE_REGEX = /<\/?\s*?br\s*?\/?>/g; // <br>, <br > <br/> <br />
	private get newLineRegex(): RegExp {
		return /\r?\n/g;
	}

	private pathToManPages: string;
	private pathToHtmlPages: string;
	private get pathToStylesCss(): string {
		return path.join(this.$staticConfig.HTML_COMMON_HELPERS_DIR, "styles.css");
	}

	private get pathToBasicPage(): string {
		return path.join(this.$staticConfig.HTML_COMMON_HELPERS_DIR, "basic-page.html");
	}

	private pathToImages = this.$staticConfig.HTML_CLI_HELPERS_DIR;
	private get pathToIndexHtml(): string {
		return path.join(this.$staticConfig.HTML_PAGES_DIR, "index.html");
	}

	constructor(private $logger: ILogger,
		private $injector: IInjector,
		private $errors: IErrors,
		private $fs: IFileSystem,
		private $staticConfig: Config.IStaticConfig,
		private $extensibilityService: IExtensibilityService,
		private $microTemplateService: IMicroTemplateService,
		private $opener: IOpener) {
		this.pathToHtmlPages = this.$staticConfig.HTML_PAGES_DIR;
		this.pathToManPages = this.$staticConfig.MAN_PAGES_DIR;
	}

	public async openHelpForCommandInBrowser(commandName: string): Promise<void> {
		const htmlPage = await this.convertCommandNameToFileName(commandName) + HelpService.HTML_FILE_EXTENSION;
		this.$logger.trace("Opening help for command '%s'. FileName is '%s'.", commandName, htmlPage);

		this.$fs.ensureDirectoryExists(this.pathToHtmlPages);
		if (!this.tryOpeningSelectedPage(htmlPage)) {
			// HTML pages may have been skipped on post-install, lets generate them.
			this.$logger.trace("Required HTML file '%s' is missing. Let's try generating HTML files and see if we'll find it.", htmlPage);
			await this.generateHtmlPages();
			if (!this.tryOpeningSelectedPage(htmlPage)) {
				this.$errors.failWithoutHelp("Unable to find help for '%s'", commandName);
			}
		}
	}

	public async generateHtmlPages(): Promise<void> {
		const mdFiles = this.$fs.enumerateFilesInDirectorySync(this.pathToManPages);
		const basicHtmlPage = this.$fs.readText(this.pathToBasicPage);
		await Promise.all(_.map(mdFiles, markdownFile => this.createHtmlPage(basicHtmlPage, markdownFile, this.pathToManPages, this.pathToHtmlPages)));
		// Now do it for all extensions
		const installedExtensions = _.keys(this.$extensibilityService.getInstalledExtensions());
		for (const extensionName of installedExtensions) {
			const pathToExtension = this.$extensibilityService.getPathToExtension(extensionName);
			const pathToPackageJson = path.join(pathToExtension, PACKAGE_JSON_FILE_NAME);
			const jsonData = this.$fs.readJson(pathToPackageJson);
			const docsDir = jsonData && jsonData.nativescript && jsonData.nativescript.docs;

			if (docsDir) {
				const docsDirFullPath = path.join(pathToExtension, docsDir);
				const htmlDirFullPath = path.join(path.dirname(docsDirFullPath), "html");
				this.$fs.ensureDirectoryExists(htmlDirFullPath);
				console.log("############", docsDirFullPath, " ############ ", htmlDirFullPath);
				const extensionMdFiles = this.$fs.enumerateFilesInDirectorySync(docsDirFullPath);
				await Promise.all(_.map(extensionMdFiles, markdownFile => this.createHtmlPage(basicHtmlPage, markdownFile, docsDirFullPath, htmlDirFullPath)));
				// 	pageToOpen = _.find(this.$fs.enumerateFilesInDirectorySync(htmlDirFullPath), file => path.basename(file) === htmlPage);
			}
		}
		this.$logger.trace("Finished generating HTML files.");
	}

	public async showCommandLineHelp(commandName: string): Promise<void> {
		const help = await this.getCommandLineHelpForCommand(commandName);
		if (this.$staticConfig.FULL_CLIENT_NAME) {
			this.$logger.info(this.$staticConfig.FULL_CLIENT_NAME.green.bold + EOL);
		}

		this.$logger.printMarkdown(help);
	}

	/**
	 * Gets the help content for a specific command that should be shown on the terminal.
	 * @param {string} commandName Name of the command for which to read the help.
	 * @returns {Promise<string>} Help content of the command parsed with all terminal rules applied (stripped content that should be shown only for html help).
	 */
	private async getCommandLineHelpForCommand(commandName: string): Promise<string> {
		const helpText = await this.readMdFileForCommand(commandName);
		const commandLineHelp = (await this.$microTemplateService.parseContent(helpText, { isHtml: false }))
			.replace(/&nbsp;/g, " ")
			.replace(HelpService.MARKDOWN_LINK_REGEX, "$1")
			.replace(HelpService.SPAN_REGEX, (matchingSubstring: string, textBeforeSpan: string, textInsideSpan: string, index: number, fullString: string): string => {
				return textBeforeSpan + textInsideSpan.replace(this.newLineRegex, "");
			})
			.replace(HelpService.NEW_LINE_REGEX, EOL);

		return commandLineHelp;
	}

	// This method should return Promise in order to generate all html pages simultaneously.
	private async createHtmlPage(basicHtmlPage: string, pathToMdFile: string, pathToMdPages: string, pathToHtmlPages: string): Promise<void> {
		const mdFileName = path.basename(pathToMdFile);
		const htmlFileName = mdFileName.replace(HelpService.MARKDOWN_FILE_EXTENSION, HelpService.HTML_FILE_EXTENSION);
		this.$logger.trace("Generating '%s' help topic.", htmlFileName);

		const helpText = this.$fs.readText(pathToMdFile);
		const outputText = await this.$microTemplateService.parseContent(helpText, { isHtml: true });
		const htmlText = marked(outputText);

		const filePath = pathToMdFile
			.replace(path.basename(pathToMdPages), path.basename(pathToHtmlPages))
			.replace(mdFileName, htmlFileName);
		this.$logger.trace("HTML file path for '%s' man page is: '%s'.", mdFileName, filePath);

		const outputHtml = basicHtmlPage
			.replace(HelpService.MAN_PAGE_NAME_REGEX, mdFileName.replace(HelpService.MARKDOWN_FILE_EXTENSION, ""))
			.replace(HelpService.HTML_COMMAND_HELP_REGEX, htmlText)
			.replace(HelpService.RELATIVE_PATH_TO_STYLES_CSS_REGEX, path.relative(path.dirname(filePath), this.pathToStylesCss))
			.replace(HelpService.RELATIVE_PATH_TO_IMAGES_REGEX, path.relative(path.dirname(filePath), this.pathToImages))
			.replace(HelpService.RELATIVE_PATH_TO_INDEX_REGEX, path.relative(path.dirname(filePath), this.pathToIndexHtml));

		this.$fs.writeFile(filePath, outputHtml);
		this.$logger.trace("Finished writing file '%s'.", filePath);
	}

	private async convertCommandNameToFileName(commandName: string): Promise<string> {
		const defaultCommandMatch = commandName && commandName.match(/(\w+?)\|\*/);
		if (defaultCommandMatch) {
			this.$logger.trace("Default command found. Replace current command name '%s' with '%s'.", commandName, defaultCommandMatch[1]);
			commandName = defaultCommandMatch[1];
		}

		const availableCommands = this.$injector.getRegisteredCommandsNames(true).sort();
		this.$logger.trace("List of registered commands: %s", availableCommands.join(", "));
		if (commandName && !_.includes(availableCommands, commandName)) {
			this.$errors.failWithoutHelp("Unknown command '%s'. Try '$ %s help' for a full list of supported commands.", commandName, this.$staticConfig.CLIENT_NAME.toLowerCase());
		}

		return (commandName && commandName.replace(/\|/g, "-")) || "index";
	}

	private tryOpeningSelectedPage(htmlPage: string): boolean {
		const fileList = this.$fs.enumerateFilesInDirectorySync(this.pathToHtmlPages);
		this.$logger.trace("File list: " + fileList);
		let pageToOpen = _.find(fileList, file => path.basename(file) === htmlPage);
		if (!pageToOpen) {
			const installedExtensions = _.keys(this.$extensibilityService.getInstalledExtensions());
			for (const extensionName of installedExtensions) {
				const pathToExtension = this.$extensibilityService.getPathToExtension(extensionName);
				const pathToPackageJson = path.join(pathToExtension, PACKAGE_JSON_FILE_NAME);
				const jsonData = this.$fs.readJson(pathToPackageJson);
				const docsDir = jsonData && jsonData.nativescript && jsonData.nativescript.docs;
				// TODO: Use html dir somewhere
				if (docsDir) {
					const docsDirFullPath = path.join(pathToExtension, docsDir);
					const htmlDirFullPath = path.join(path.dirname(docsDirFullPath), "html");
					pageToOpen = _.find(this.$fs.enumerateFilesInDirectorySync(htmlDirFullPath), file => path.basename(file) === htmlPage);
				}
			}
		}

		if (pageToOpen) {
			this.$logger.trace("Found page to open: '%s'", pageToOpen);
			this.$opener.open(pageToOpen);
			return true;
		}

		this.$logger.trace("Unable to find file: '%s'", htmlPage);
		return false;
	}

	private async readMdFileForCommand(commandName: string): Promise<string> {
		const mdFileName = await this.convertCommandNameToFileName(commandName) + HelpService.MARKDOWN_FILE_EXTENSION;
		this.$logger.trace("Reading help for command '%s'. FileName is '%s'.", commandName, mdFileName);

		let markdownFile = _.find(this.$fs.enumerateFilesInDirectorySync(this.pathToManPages), file => path.basename(file) === mdFileName);
		if (!markdownFile) {
			// Try getting help from extensions
			const installedExtensions = _.keys(this.$extensibilityService.getInstalledExtensions());
			for (const extensionName of installedExtensions) {
				const pathToExtension = this.$extensibilityService.getPathToExtension(extensionName);
				const pathToPackageJson = path.join(pathToExtension, PACKAGE_JSON_FILE_NAME);
				const jsonData = this.$fs.readJson(pathToPackageJson);
				const docsDir = jsonData && jsonData.nativescript && jsonData.nativescript.docs;
				if (docsDir) {
					markdownFile = _.find(this.$fs.enumerateFilesInDirectorySync(path.join(pathToExtension, docsDir)), file => path.basename(file) === mdFileName);
				}
			}
		}

		if (markdownFile) {
			return this.$fs.readText(markdownFile);
		}

		this.$errors.failWithoutHelp("Unknown command '%s'. Try '$ %s help' for a full list of supported commands.", mdFileName.replace(".md", ""), this.$staticConfig.CLIENT_NAME.toLowerCase());
	}
}

$injector.register("helpService", HelpService);
