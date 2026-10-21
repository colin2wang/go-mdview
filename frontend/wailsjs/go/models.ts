export namespace mdv {
	
	export class Entry {
	    path: string;
	    name: string;
	    dir: string;
	    exists: boolean;
	    openedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.dir = source["dir"];
	        this.exists = source["exists"];
	        this.openedAt = source["openedAt"];
	    }
	}
	export class FileContent {
	    path: string;
	    name: string;
	    dir: string;
	    content: string;
	    encoding: string;
	    size: number;
	    modTime: number;
	
	    static createFrom(source: any = {}) {
	        return new FileContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.dir = source["dir"];
	        this.content = source["content"];
	        this.encoding = source["encoding"];
	        this.size = source["size"];
	        this.modTime = source["modTime"];
	    }
	}
	export class Node {
	    name: string;
	    path: string;
	    isDir: boolean;
	    children?: Node[];
	
	    static createFrom(source: any = {}) {
	        return new Node(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.isDir = source["isDir"];
	        this.children = this.convertValues(source["children"], Node);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Settings {
	    theme: string;
	    fontSize: number;
	    codeWrap: boolean;
	    sidebarWidth: number;
	    lastFolder: string;
	    lastFile: string;
	    pinned: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.fontSize = source["fontSize"];
	        this.codeWrap = source["codeWrap"];
	        this.sidebarWidth = source["sidebarWidth"];
	        this.lastFolder = source["lastFolder"];
	        this.lastFile = source["lastFile"];
	        this.pinned = source["pinned"];
	    }
	}

}

