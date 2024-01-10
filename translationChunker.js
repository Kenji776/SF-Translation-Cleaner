/**
 * @Name SF-Translation-Cleaner
 * @Date 2/1/2023
 * @Author Daniel Llewellyn
 * @Description Chunks a translation file into it's constituant metadata types to help try to resolve import errors.
 */
 
const configFileName = "config.json";
const fs = require("fs");
const path = require("path");
const readline = require('readline');


let customLabelsData = null;

//entries to write into the program log on completion
let logEntries = [];



//default config options
let config = {

};


/**
* @Description Entry point function. Loads configuration, checks it for validity and calls the menu to display to the user
*/
async function init() {
    console.log("                                    Salesforce Translation Cleaner\r\n");
    console.log("                                     Author: Daniel Llewellyn\r\n");

    let d = new Date();
    d.toLocaleString();

    log("Started process at " + d, false);
	
	log('Starting cleaning of translation files',true,'green');
    //load the configuration from the JSON file.
    let loadedConfig = loadConfig(configFileName);
    config = { ...config, ...loadedConfig };	
	

	let processingResult = await processTranslations(config.chunksInputFolder, config.chunksOutputFolder, config.sourceFilesType);

}


/**
* @description iterates over the translation files in the given directory and sends them for cleaning.
* @param {string} sourceDir the local folder the translation files (.stf or xlf are located).
* @param {string} destDir the local folder the cleaned files should be written to
* @param {string} fileType the file type filter to use to only process files of the given type. Should be .stf or .xlf.
*/
async function processTranslations(sourceDir='input', destDir='output', fileType='.stf') {
	log(`Reading ${fileType} files from ${sourceDir}`,true);
	
	let promises = [];
	
	//try {
        // Get the files as an array
        let files = await fs.promises.readdir( sourceDir );

		//filter the files to only get the types we are interested in.
		files = files.filter(file => {
			return path.extname(file).toLowerCase() === fileType;
		});

        // Loop them all
        for( const file of files ) {
            // Get the full paths
            const sourcePath = path.join( sourceDir, file );
            const toPath = path.join( destDir, file );

            // Stat the file to see if we have a file or dir
            const stat = await fs.promises.stat( sourcePath );

            if( stat.isFile() ){
				if(fileType == '.stf') promises.push( chunkStfFile(sourceDir, file, destDir) );
				//else if(fileType == '.xlf') promises.push( cleanXlfFile(sourceDir, file, destDir) );
			}
            else if( stat.isDirectory() ){
                log( sourcePath + ' is a directory. skipping. ' );
			}
        }
	/*	
    }
    catch( e ) {
        log( "Error reading source translation files to send for processing " + e.message, true, 'red' );
    }*/

	//once all promises the from the cleanStfFile function calls are resolved then log them. This doesn't seem to work quite right as I don't think the the cleanStfFile function is resolving/returning its
	//promises correctly.
	return Promise.all(promises);
}

/**
* @description cleans the given translation .xlf file of bad references by reading each line and checking for it's related metadata in the local file system's project folder. 
* @param {string} sourceDir the local directory where the translation file is located
* @param {string} file the name of the translation file to read. Should be a .stf file.
* @param {destDir} the destination directory to write the cleaned file to.
*/
async function cleanXlfFile(sourceDir, file, destDir){
	const filePath = path.join( sourceDir, file );
	
	let fileData = fs.readFileSync(filePath, 'utf-8', function (err) {
		log('Could not read xlf translation file '+sourceDir+'\\'+file+'. ' + err.message, true, "red");
		return false;
	});
	
	let translationFileData = await xmlToJson(fileData);
	
	let root = translationFileData.xliff.file[0].body[0]['trans-unit'];
	
	//lets remove any untranslated items to reduce processing time
	for (var i = root.length - 1; i >= 0; i--) {
		if (!root[i].hasOwnProperty('target')) { 
			root.splice(i, 1);
		}
	}

	//now that our object has only things that are only translated, lets check and see if this translation has a corresponding metadata entry on the local file system
	for (var i = root.length - 1; i >= 0; i--) {
		let thisTranslation = new TranslationObject(root[i]);
			
		if (!doesLocalMetadataExist(thisTranslation.metadataType,thisTranslation.objectName,thisTranslation.elementName)) { 
			root.splice(i, 1);
		}
	}
	
	console.log('Finishing cleaning translation root of bad references. There are '+root.length+' remaining valid translations.');
	
	translationFileData.xliff.file[0].body[0]['trans-unit'] = root;
	
	writeXmlFromJSON(translationFileData, destDir, file);
}

/**
* @description cleans the given translation .stf file of bad references by reading each line and checking for it's related metadata in the local file system's project folder.
* @param {string} sourceDir the local directory where the translation file is located
* @param {string} file the name of the translation file to read. Should be a .stf file.
* @param {destDir} the destination directory to write the cleaned file to.
*/
async function chunkStfFile(sourceDir, file, destDir){
	let headerContent = [];
	let chunks = {};

	const filePath = path.join( sourceDir, file );
	
	log('Chunking File: ' + filePath);
	
	const fileStream = fs.createReadStream(filePath);
	
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity
	});
		// Note: we use the crlfDelay option to recognize all instances of CR LF
		// ('\r\n') in input.txt as a single line break.

	let startCleaning = false;

	//check each line of our translation file to see if the related metadata exists locally.
	let chunkIndex = 0;
	let linesInChunk = 0;
	let lastMetadata = '';
	for await (const line of rl) {
		let lineValid = false;
		
		//try{
			if(!startCleaning){		
				headerContent.push(line);
			}
			

			if(config.abortOnUntranslated && line.trim() == '------------------OUTDATED AND UNTRANSLATED-----------------') {
				log('End of translatable elements reached. "------------------OUTDATED AND UNTRANSLATED-----------------" encountered. Aborting',true,'yellow');
				break;
			}
			
			if(line.trim().substring(1) === '0' || line.trim().substring(1) === '') continue;
			
			if(!startCleaning && line.trim() === '# KEY	LABEL	TRANSLATION	OUT OF DATE') {
				log('Start of data payload found. Will start cleaning on next line');
				startCleaning = true;
				continue;
			}
			
			
			
			if(startCleaning){				
				//the line is tab delimited, so split on tabs to break it into its constituant chunks
				const keys = line.split("\t");
				
				//the 'identifier' of what kind of metadata this is in the the first chunk of the link, deliniated by .
				//EX: PicklistValue.Queue_Share__c.Related_Object.Complaint Analysis
				const metadataParts = keys[0].split('.');
				
				//generally speaking (but not an absolute rule) the parts of the identifier are first the metadata type, second the object it pertains to, and finally the element (field usually) specifically on that object this translation is for
				//some metadata types act differently so you'll see some checks using these variables in ways that are not immediatly intuitive based on their name
				let metadataType = metadataParts[0];
				let objectName = metadataParts[1];
				let elementName = metadataParts[2];

				let chunkContainer = metadataType;
				
				//reset chunk index if metadata type is different
				if(lastMetadata != metadataType){
					chunkIndex = 0;
				}
				
				//record this lines metadata type so we can compare it during the next iteration for the above if statment
				lastMetadata = metadataType;
				
				//if breaking chunk files on sub type set the chunk id...
				if(config.breakChunksOnSubTypes ){
					chunkContainer = metadataType+'_'+objectName;
				}
				//if breaking chunk files per number of lines in chunk file set the chunk id...
				else if(config.linesPerChunk && config.linesPerChunk > 0){
					chunkContainer = metadataType+'_'+chunkIndex;			
				}			
						
				//create empty container for chunk if it doesn't exist
				if(!chunks.hasOwnProperty(chunkContainer)){
					chunks[chunkContainer] = [];
				}
				
				//find out how many lines are in our current chunk.
				linesInChunk = chunks[chunkContainer] ? chunks[chunkContainer].length : 0;
				
				//if we've hit the limit of lines in this chunk, increase index so next iteration it creates a new chunk file.
				if(config.linesPerChunk && linesInChunk+1 == config.linesPerChunk){
					
					chunkIndex++;
					console.log('Chunk index increased to: ' + chunkIndex);
				}

				chunks[chunkContainer].push(line);

								
			}

		/*}catch(ex){
			 log("Erroring processing translation line in file. " + ex.message, true, "red");
		}*/
	}
	
	log('Finished chunking file. Writting chunks');
	
	for (let [key, value] of Object.entries(chunks)) {
		let filenameParts = file.split('.');
		let filename = `${filenameParts[0].replace('metadata_Bilingual_','')}_${key}.${filenameParts[filenameParts.length-1]}`; 
		writeTranslationFile(destDir, filename , [...headerContent, ...value]);	
	}
	
	return new Promise((resolve) => {
		resolve(chunks);
	});
	
}

function writeTranslationFile(destFolder, fileName, lines){
	try{
		fs.writeFileSync(destFolder+'\\'+fileName, lines.join('\r\n'), 'utf8', function(){;
			log('Wrote file ' + destFolder + '\\' + fileName, true, 'green');
		});
	}catch(ex){
		console.log(ex);
	}
}


/**
* @description iterates over the translation files in the given directory and sends them for cleaning.
* @param {string} sourceDir the local folder the translation files (.stf or xlf are located).
* @param {string} destDir the local folder the cleaned files should be written to
* @param {string} fileType the file type filter to use to only process files of the given type. Should be .stf or .xlf.
*/
async function generateFinalReport(sourceDir='translationLogs', fileType='.log') {
	log(`Reading ${fileType} files from ${sourceDir}`,true);
	
	let promises = [];
	
	try {
        // Get the files as an array
        let files = await fs.promises.readdir( sourceDir );

		//filter the files to only get the types we are interested in.
		files = files.filter(file => {
			return path.extname(file).toLowerCase() === fileType;
		});

        // Loop them all
		let logs = {};
        for( const file of files ) {
            // Get the full paths
            const sourcePath = path.join( sourceDir, file );

            // Stat the file to see if we have a file or dir
            const stat = await fs.promises.stat( sourcePath );

            if( stat.isFile() ){
				if(fileType == '.stf') promises.push( cleanStfFile(sourceDir, file, destDir) );
				
					let fileData = fs.readFileSync(`${sourceDir}\\${file}`, 'utf-8', function (err) {
						log('Could not read error log file. Unable to process erroring elements' + err.message, true, "red");
						return false;
					});
					
					logEntry = JSON.parse(fileData);
					
					
					logs[logEntry.details.languageCode] = logEntry.details;
			}
        }
		
		let reportCsvContent = ['Language,LanguageCode,TotalEntries,ValidEntries,InvalidEntries,ValidPercent,InvalidPercent'];
		for (let [key, l] of Object.entries(logs)) {
			reportCsvContent.push(`${l.language},${l.languageCode},${l.total},${l.valid},${l.invalid},${l.validPercent},${l.invalidPercent}`);
		}
		
		fs.writeFileSync('Translation Cleaning Final Report.csv', reportCsvContent.join('\r\n'), function(err){
			if(err) {
				return log(err);
			}
			log("The Translation Cleaning Final Report.csv file was saved!");
		});	
		
		
		console.log(reportCsvContent);
		
    }
    catch( e ) {
        log( "Error reading source translation files to send for processing " + e.message, true, 'red' );
    }

	//once all promises the from the cleanStfFile function calls are resolved then log them. This doesn't seem to work quite right as I don't think the the cleanStfFile function is resolving/returning its
	//promises correctly.
	return Promise.all(promises);
}


function readFile(filePath){
	log('Reading file ' + filePath);
	let fileData = '';
	try{
		let fileData = fs.readFileSync(filePath, 'utf-8', function (err) {
			log("File not found or unreadable." + err.message, true, "red");
			return fileData;
		});
	}catch(ex){
			log("File not found or unreadable." + ex.message, true, "red");
			return fileData;		
	}
	log('File Found', true, 'green');
	return fileData;
}
/**
 * @Description Parses the raw HTML content fetched by getOutboundChangeSets() to return an array containing all the change set names.
 * @Param html a string of HTML that contains the change set names fetched from the Salesforce UI
 * @Return
 */
function loadConfig(configFileName) {
    return readJSONFromFile(configFileName);
}
/**
 * @Description Reads and parses JSON from a given file.
 * @Param fileName the name of the file to read, parse, and return.
 * @Return a JSON object.
 */
function readJSONFromFile(fileName) {
    let fileJSON = fs.readFileSync(fileName, 'utf-8', function (err) {
        log("File not found or unreadable. Skipping import" + err.message, true, "red");
        return null;
    });

	//strip any comments from our JSON sting
	fileJSON = fileJSON.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
    const parsedJSON = JSON.parse(fileJSON);
    return parsedJSON;
}



/**
* @Description clears the terminal screen.
*/
function clearScreen(){
	console.log('\033[2J');
	process.stdout.write('\033c');
}

/**
 * @Description Creates a log entry in the log file, and optionally displays log entry to the terminal window with requested color.
 * @Param logItem a string of data to log
 * @Param printToScreen boolean flag indicating if this entry should be printed to the screen (true) or only to the log file (false)
 * @Param a string {'red','green','yellow'} that indicates what color the logItem should be printed in on the screen..
 */
function log(logItem, printToScreen, color) {
    printToScreen = printToScreen != null ? printToScreen : true;
    var colorCode = "";
    switch (color) {
        case "red":
            colorCode = "\x1b[31m";
            break;
        case "green":
            colorCode = "\x1b[32m";
            break;
        case "yellow":
            colorCode = "\x1b[33m";
    }

    if (printToScreen) console.log(colorCode + "" + logItem + "\x1b[0m");

	logEntries.push(logItem);
}

/**
* @Description Method that executes at the end of a script run. Writes to the log file. Exits the program.
*/
function finish() {
    log("Process completed. Writting " + logEntries.length + " log entries", true, "yellow");
    log("\r\n\r\n------------------------------------------------ ", false);
	
    fs.writeFileSync("log.txt", logEntries.join("\r\n"), function (err) {
        if (err) {	
			console.log('Unable to write to log file');
			console.log(err);
		}
    });
	process.exit(1);
}

/**
 * @Description Method that executes on an uncaught error.
*/
process.on("uncaughtException", (err) => {
    log(err, true, "red");
	console.trace(err);
	finish();
});

init();