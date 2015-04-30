///<reference path="../.d.ts"/>
"use strict";
import Future = require("fibers/future");

export class HostInfo implements IHostInfo {
	private static WIN32 = "win32";
	private static PROCESSOR_ARCHITEW6432 = "PROCESSOR_ARCHITEW6432";
	private static DARWIN_OS_NAME = "darwin";
	private static LINUX_OS_NAME = "linux";
	private static DOT_NET_REGISTRY_PATH = "\\Software\\Microsoft\\NET Framework Setup\\NDP\\v4\\Client";

	constructor(private $errors: IErrors) { }

	public get isWindows() {
		return process.platform === HostInfo.WIN32;
	}

	public get isWindows64() {
		return this.isWindows && (process.arch === "x64" || process.env.hasOwnProperty(HostInfo.PROCESSOR_ARCHITEW6432));
	}

	public get isWindows32() {
		return this.isWindows && !this.isWindows64;
	}

	public get isDarwin() {
		return process.platform === HostInfo.DARWIN_OS_NAME;
	}

	public get isLinux() {
		return process.platform === HostInfo.LINUX_OS_NAME;
	}

	public get isLinux64(): boolean {
		return this.isLinux && process.config.variables.host_arch === "x64";
	}

	public dotNetVersion(message: string, opts?: {throwErr?: boolean}): IFuture<string> {
		if (this.isWindows) {
			opts = opts || {};
			var result = new Future<string>();
			var Winreg = require("winreg");
			var regKey = new Winreg({
				hive: Winreg.HKLM,
				key: HostInfo.DOT_NET_REGISTRY_PATH
			});
			regKey.get("Version", (err: Error, value: any) => {
				if (err) {
					if(opts.throwErr) {
						this.$errors.failWithoutHelp(message);
					}
					result.throw(new Error(message));
				} else {
					result.return(value.value);
				}
			});
			return result;
		} else {
			return Future.fromResult<string>(null);
		}
	}

	public isDotNet40Installed(message?: string) : IFuture<boolean> {
		return (() => {
			if (this.isWindows) {
				try {
					this.dotNetVersion(message || "An error occurred while reading the registry.", { throwErr: true }).wait();
					return true;
				} catch (e) {
					return false;
				}
			} else {
				return false;
			}
		}).future<boolean>()();
	}
}
$injector.register("hostInfo", HostInfo);


