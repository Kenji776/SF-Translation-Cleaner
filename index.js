/**
 * @Name SF-Translation-Cleaner
 * @Date 2/1/2023
 * @Author Daniel Llewellyn
 * @Description This is a Node.js application that will remove invalid translation data from a file by comparing the translation definition to existing meta data to remove translations for things that do not exist. This will
 allow you to move translation files between similar but not identical orgs.
 */
 
const configFileName = "config.json";
const fs = require("fs");
const path = require("path");
const readline = require('readline');
let customLabelsData = null;
let metadataTypes = [];
let logEntries = [];

//object containing cached information read from files to reduce file reads 
let cachedFileData = {}; 

//default config options
let config = {

};

//allows for user input
function prompt(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }))
}

/**
* @Description Entry point function. Loads configuration, checks it for validity and calls the menu to display to the user
*/
async function init() {
    console.log("                                    Salesforce Translation Cleaner\r\n");
    console.log("                                     Author: Daniel Llewellyn\r\n");

    let d = new Date();
    d.toLocaleString();

    log("Started process at " + d, false);
	

    //load the configuration from the JSON file.
    let loadedConfig = loadConfig(configFileName);
    config = { ...config, ...loadedConfig };	
	
	loadCustomLabelsIntoMemory();
	
	await processTranslations(config.sourceDir, config.destDir);
	
	//finish();
}

function loadCustomLabelsIntoMemory(){
	
	if(!fileExists(`${config.orgDataLocation}\\labels\\CustomLabels.labels-meta.xml`)){
		log('Could not load custom labels file into memory. Custom label translation analysis will not work', true, "red");
		return false;
	}
	customLabelsData = fs.readFileSync(`${config.orgDataLocation}\\labels\\CustomLabels.labels-meta.xml`, 'utf-8', function (err) {
		log('Could not load custom labels file into memory. Custom label translation analysis will not work' + err.message, true, "red");
		return false;
	});	
	return true;
}
async function processTranslations(sourceDir, destDir) {
	const promises = [];
	
	try {
        // Get the files as an array
        const files = await fs.promises.readdir( sourceDir );

        // Loop them all with the new for...of
		
		
		
        for( const file of files ) {
            // Get the full paths
            const sourcePath = path.join( sourceDir, file );
            const toPath = path.join( destDir, file );

            // Stat the file to see if we have a file or dir
            const stat = await fs.promises.stat( sourcePath );

            if( stat.isFile() ){
                log( sourcePath + ' is a file ' );
			
				promises.push( await cleanTranslationFile(sourceDir, file, destDir) );
			}
            else if( stat.isDirectory() ){
                log( sourcePath + ' is a directory. skipping. ' );
			}
        } 
    }
    catch( e ) {
        // Catch anything bad that happens
        console.error( "We've thrown! Whoops!", e );
    }
	
	Promise.all(promises)
	.then(() => {
		log('All translations processed successfully!',true,'green');
	})
	.catch((e) => {
		log('Error processing translations!',true,'red');
		log(e);
	});
}

async function cleanTranslationFile(sourceDir, file, destDir){
	let validLines = [];
	let headerContent = [];
	let badLines = [];
	let totals = {
		details:  {
			sourceDir: sourceDir,
			file: file,
			destDir: destDir
		}
	};
	const filePath = path.join( sourceDir, file );
	
	log('Cleaning File: ' + filePath);
	
	const fileStream = fs.createReadStream(filePath);
	
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity
	});
		// Note: we use the crlfDelay option to recognize all instances of CR LF
		// ('\r\n') in input.txt as a single line break.

	let startCleaning = false;

	//check each line of our translation file to see if the related metadata exists locally.
	for await (const line of rl) {
		let lineValid = false;
		
		//try{
			
			if(!startCleaning){
				headerContent.push(line);
			}
			
			if(line.trim().substring(1) === '0' || line.trim().substring(1) === '') continue;
			
			if(!startCleaning && line.trim() === '# KEY	LABEL	TRANSLATION	OUT OF DATE') {
				log('Start of data payload found. Will start cleaning on next line');
				startCleaning = true;
				continue;
			}
			
			if(startCleaning){		
				// Each line in input.txt will be successively available here as `line`.
				//console.log(`Line from file: ${line}`);
				
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
								
				//okay this is super annoying. For some reason in the translation file, custom metadata types get the suffix __c when really they should have the suffix __mdt. So if our object ends with __c, check to make sure
				//an object folder actually exists for it. If not, test to see if one exists with __mdt instead and then overwrite the __c with __mdt instead. So for example the custom metadata 
				//Service_Complaint_Analysis_Routing__mdt
				//shows up in our translation file with an entry for a picklist value like this.
				//CustomField.Service_Complaint_Analysis_Routing__c.Complaint_Reason.FieldLabel	Complaint Reason
				//See how that __c is incorrect? We need to change that, but we have no way of knowing ahead of time that this a metadata because the very thing that would tell us that (having an __mdt as it's postfix) is incorrect. So we just test both.
				if(objectName && objectName.endsWith('__c') && fileExists(`${config.orgDataLocation}\\objects\\${objectName.replace('__c','__mdt')}`)){
					objectName = objectName.replace('__c','__mdt');
					log(`Object detected as custom metadata. Replacing __c with __mdt`);
				}
				
				//create a running tally of all the metadata types and their member translations that we either carry over or discard
				if(!totals.hasOwnProperty(metadataType)){
					log('Adding metadata type: ' + metadataType);
					metadataTypes.push(metadataType);
					totals[metadataType] = {
						total: 0,
						valid: 0,
						invalid: 0
					};
				};
				
				if(config.translationTypes.hasOwnProperty(metadataType)){
					log('Evaluating Existance of ' + objectName + '.' + elementName);
					
					totals[metadataType].total++;
					let lineValid = false;
					//now depending on what metadata type we are dealing with we need different logic to evaluate if this line is relevant to the current org or not. In many cases we check for the existance of a file
					//that would indicate the metadata described by the translation exists in this org. For some, like customLabels we need to look at the contents of a file to look for a specific string to see if it exists.
					switch(metadataType) {
						case 'ButtonOrLink':
							//local path: \objects\Account\webLinks\Apttus__ViewAgreementHierarchyforAccount.webLink-meta.xml
							//rule def: ButtonOrLink.Account.Apttus__ViewAgreementHierarchyforAccount	View Agreement Hierarchy for Account (Link)	取引先の合意階層を表示（リンク）	-		
							lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\webLinks\\${elementName}.webLink-meta.xml`);
							break;

						//When looking for a custom app it is found in the applications directory with a folder named after the 'object' (	
						case 'CustomApp':
							lineValid = fileExists(`${config.orgDataLocation}\\applications\\${objectName}.app-meta.xml`);
							break;
							
						case 'CustomField':
							lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\fields\\${elementName}__c.field-meta.xml`);
							break;
							
						case 'LayoutSection':
							lineValid = fileExists(`${config.orgDataLocation}\\layouts\\${objectName}-${elementName}__c.layout-meta.xml`);
							break;
							
						case 'LookupFilter':
							break;
							
						case 'PicklistValue':
							//first check to make sure the field even exists before evaluating its picklist values
							let fieldExists = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\fields\\${elementName}__c.field-meta.xml`);
							
							if(!fieldExists) {
								log(`Object or field ${objectName}.${elementName} do not exist. Skipping picklist value evaluation`);
								break;
							}
							
							let picklistValue = metadataParts[3];
							
							log(`Looking for value <fullName>${picklistValue}</fullName> in text of body`);
							
							let fieldData = getStoredData(metadataType,objectName,elementName);
							
							if(fieldData && fieldData.indexOf(`<fullName>${picklistValue}</fullName>`) > -1) lineValid = true;
							
							if(lineValid) log('Picklist '+elementName+' value is valid',true,'green');
							else log('Picklist value '+elementName+' is invalid',true,'red');
							
							break;
							
						case 'RecordType':
							lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\recordTypes\\${elementName}.recordType-meta.xml`);
							break;
							
						case 'ValidationFormula':
							//local path: \objects\Account_Request__c\validationRules\AR_VR01_OnePendingRequest.validationRule-meta.xml
							//rule def: ValidationFormula.Account_Request__c.AR_VR01_OnePendingRequest	There are already pending changes for this Account. Please retry when there are no more pending changes.
							lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\validationRules\\${elementName}.validationRule-meta.xml`);
							break;
							
						case 'WebTab':
							//local path: tabs\Apttus_Proposal__AboutProposalManagement.tab-meta.xml
							//rule def: WebTab.Apttus_Proposal__AboutProposalManagement	About Proposal Management
							lineValid = fileExists(`${config.orgDataLocation}\\tabs\\${objectName}.tab-meta.xml`)
							break;
							
						case 'CustomLabel':
							if(customLabelsData && customLabelsData.indexOf(`<fullName>${objectName}</fullName>`) > -1) lineValid = true;
							break;
							
						case 'ApexSharingReason':
							//local path: objects\Sales_Coach__c\sharingReasons\Coaching_Moment_Coach__c.sharingReason-meta.xml
							//rule def: ApexSharingReason.Sales_Coach__c.Coaching_Moment_Coach	Coaching Moment Coach
							lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\sharingReasons\\${elementName}__c.sharingReason-meta.xml`);
							break;
							
						case 'CustomReportType':
							//local path: reportTypes\Accounts_with_Account_Requests.reportType-meta.xml
							//rule def: CustomReportType.Accounts_with_Account_Requests.Name	Accounts w/ Account Requests + User Details - CRTD
							lineValid = fileExists(`${config.orgDataLocation}\\reportTypes\\${objectName}.reportType-meta.xml`);						
						
							break;
							
						case 'CrtLayoutSection':
							break;
							
						case 'CrtColumn':
							break;
							
						case 'DataCategory':
							//local path: \datacategorygroups\Geo.datacategorygroup-meta.xml
							//rule def: DataCategory.Geo.APAC	APAC
							
							//first check to make sure the Data Category Group even exists before evaluating its DataCategory values
							let dataCategoryGroupExists = fileExists(`${config.orgDataLocation}\\datacategorygroups\\${objectName}.datacategorygroup-meta.xml`);
							
							if(!dataCategoryGroupExists) {
								log(`Data Category Group ${objectName} does not exist. Skipping DataCategory value evaluation`);
								break;
							}
							
							//look for <name>${elementName}</name> in the file with the matching object name
							let dataCategoryData = getStoredData(metadataType,objectName,null);
							
							if(dataCategoryData && dataCategoryData.indexOf(`<name>${elementName}</name>`) > -1) lineValid = true;
							
							if(lineValid) log('DataCategory '+elementName+' value is valid',true,'green');
							else log('DataCategory '+elementName+' value is invalid',true,'red');
							
							break;
							
						case 'DataCategoryGroup':
						
						
							//local path: \datacategorygroups\Geo.datacategorygroup-meta.xml
							lineValid = fileExists(`${config.orgDataLocation}\\datacategorygroups\\${objectName}.datacategorygroup-meta.xml`);
							break;
							
						case 'Scontrol':
							//local path: \scontrols\Apttus_Approval__aptsApprovalBackupApprover.scf-meta.xml
							//rule def: Scontrol.Apttus_Approval__aptsApprovalBackupApprover	aptsApprovalBackupApprover
							lineValid = fileExists(`${config.orgDataLocation}\\scontrols\\${objectName}.scf-meta.xml`);
							break;
							
						case 'StandardFieldHelp':
							break;
							
						case 'WorkflowTask':
							//local path: \workflows\Case.workflow-meta.xml
							//rule def: WorkflowTask.Case.Day_5_Follow_Up_Email_Sent_to_Employee.SubjectLabel	Day 5 Follow Up Email Sent to Employee
							
							//look for <fullName>${elementName}</fullName> in the file with the matching object name
							let workflowData = getStoredData(metadataType,objectName,elementName);
							
							if(workflowData && workflowData.indexOf(`<fullName>${elementName}</fullName>`) > -1) lineValid = true;
							
							if(lineValid) log('WorkflowTask '+elementName+' value is valid',true,'green');
							else log('WorkflowTask  '+elementName+' value is invalid',true,'red');
							
							break;
							
						case 'AddressCountry':
							break;
							
						case 'AddressState':
							break;
							
						case 'Flow':
							lineValid = fileExists(`${config.orgDataLocation}\\flows\\${elementName}.flow-meta.xml`);
							break;
							
						case 'FieldSet':
							//local path: \objects\Apttus_Config2__Order__c\Apttus_Config2__CreateOrderFromPOPageFieldSet.fieldSet-meta.xml
							//rule def: FieldSet.Apttus_Config2__CustomerPOItem__c.Apttus_Config2__CreateOrderFromPOPageFieldSet	Create Order From POPage FieldSet
							lineValid = fileExists(`${config.orgDataLocation}\\objects\\${objectName}\\fieldSets\\${elementName}.fieldSet-meta.xml`);
							break;
							
						case 'QuickAction':
							lineValid = fileExists(`${config.orgDataLocation}\\quickActions\\${objectName}.${elementName}.quickAction-meta.xml`);
							break;
							
						case 'ManagedContentType':
							break;
							
						case 'ManagedContentNodeType':
							break;
							
						case 'PathAssistantStepInfo':
							break;
							
						default: 
							log('No defenition for metadata type: ' + metadataType);
					}
					if(lineValid){
						totals[metadataType].valid++;
						validLines.push(line);
					}else{
						totals[metadataType].invalid++;
						badLines.push(line);
					}	

					//id prefer these to be functions of the totals object, but since I'm just outputting it to the consol and functions doesn't get resolved during serializating we just do this instead.
					totals[metadataType].validPercent = totals[metadataType].total != 0 ? Math.round((totals[metadataType].valid/totals[metadataType].total)*100) : 0	
					totals[metadataType].removedPercent = totals[metadataType].total != 0 ? Math.round((totals[metadataType].invalid/totals[metadataType].total)*100) : 0					
				}
			}
		/*
		}catch(ex){
			 log("Erroring processing translation line in file. " + ex.message, true, "red");
		}*/
	}
	const checkedTranslations = validLines.length + badLines.length;
	const removedLines = badLines.length;
	
	totals.details.checkedTranslations = checkedTranslations;
	totals.details.removedLines = removedLines;
	totals.details.validLines = validLines.length;
	
	/*
	log('\n\nSuccessfully checked ' + checkedTranslations + ' translation entries' , true, 'green');
	log('Cleaned ' + removedLines + ' translations with invalid data');
	log('Found ' + validLines.length + ' total valid entries ' , true, 'green');
	*/
	
	log('Translation Type Totals for: ' + file);
	log(JSON.stringify(totals, null, 2));
	writeTranslationFile(destDir, file , [...headerContent, ...validLines]);	
	writeTranslationFile(config.removedTranslationsOutputFolder, file , badLines);
	
	return new Promise((resolve) => {
		resolve(totals);
	});
	
}

//function that gets file data and stores it in a cache 
function getStoredData(type,objectName,elementName){
		
	if(type && objectName && elementName && cachedFileData?.[type]?.[objectName]?.[elementName]){
		//console.log(`Returning cached value for ${type} ${objectName} ${elementName}`);
		return cachedFileData[type][objectName][elementName];
	}else if(type && objectName && !elementName && cachedFileData?.[type]?.[objectName]){
		//console.log(`Returning cached value for ${type} ${objectName}`);
		return cachedFileData[type][objectName];
	}else if(type && !objectName && !elementName && cachedFileData?.[type]){
		//console.log(`Returning cached value for ${type}`);
		return cachedFileData[type];
	}
	
	let returnData;
	
	switch(type) {
		case 'PicklistValue':
			returnData = readFile(`${config.orgDataLocation}\\objects\\${objectName}\\fields\\${elementName}__c.field-meta.xml`);
			break;
		case 'WorkflowTask':
			returnData = readFile(`${config.orgDataLocation}\\workflows\\${objectName}.workflow-meta.xml`);
			break;	
		case 'DataCategory':
			returnData = readFile(`${config.orgDataLocation}\\datacategorygroups\\${objectName}.datacategorygroup-meta.xml`); 
			break;
		default:
			log('No method for getting stored data for type '+type+' defined. The metadata type cannot current be read/cached',true,'red');
	}

	log(`Cache miss - Fetched fresh value from file for for ${type} ${objectName} ${elementName}`,true,'yellow');
	if(returnData){
		if(!cachedFileData.hasOwnProperty(type)) cachedFileData[type] = {};
		if(!cachedFileData[type].hasOwnProperty(objectName)) cachedFileData[type][objectName] = {};
		
		if(elementName) cachedFileData[type][objectName][elementName] = returnData;
		else cachedFileData[type][objectName] = returnData; 
	}
	
	return returnData;
}

//Checks if a file exists
function fileExists(filePath){
	log('Looking for file ' + filePath);
	if (!fs.existsSync(filePath)) {
		log('File not found!', true, 'yellow');
		return false;
	}
	log('File Found', true, 'green');
	return true;
}

function readFile(filePath){
	log('Reading file ' + filePath);
	let fileData = fs.readFileSync(filePath, 'utf-8', function (err) {
        log("File not found or unreadable." + err.message, true, "red");
        return null;
    });
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
* @Description writes the current working config back into the config.json file
*/
function saveConfig(){
	fs.writeFileSync('config.json', JSON.stringify(config, null, 2), function(err){
		if(err) {
			return log(err);
		}
		log("The file was saved!");
	});
}

/**
 * @Description Reads and parses JSON from a given file.
 * @Param fileName the name of the file to read, parse, and return.
 * @Return a JSON object.
 */
function readJSONFromFile(fileName) {
    let changeSetsJsonString = fs.readFileSync(fileName, 'utf-8', function (err) {
        log("File not found or unreadable. Skipping import" + err.message, true, "red");
        return null;
    });

	//strip any comments from our JSON sting
	changeSetsJsonString = changeSetsJsonString.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
    const parsedJSON = JSON.parse(changeSetsJsonString);
    return parsedJSON;
}


function writeTranslationFile(destFolder, fileName, lines){
	fs.writeFile(destFolder+'\\'+fileName, lines.join('\r\n'), err => {
	  if (err) {
		console.error(err);
	  }
	  // file written successfully
	});
}
/**
* @Description clears the terminal screen.
*/
function clearScreen(){
	console.log('\033[2J');
	process.stdout.write('\033c');
}
/**
 * @Description Runs a shell command.
 * @Param command the name of the command to execute WITHOUT any arguments.
 * @Param arguments an array of arguments to pass to the command.
 * @Return javascript promise object that contains the result of the command execution
 */
function runCommand(command, arguments = [], nolog) {
	if(!nolog) log(command +  ' ' + arguments.join(' '));
    let p = spawn(command, arguments, { shell: true, windowsVerbatimArguments: true });
    return new Promise((resolveFunc) => {
		var output ='';
        p.stdout.on("data", (x) => {
            //process.stdout.write(x.toString());
            if(!nolog) log(x.toString());
			output += x;
        });
        p.stderr.on("data", (x) => {
			//process.stderr.write(x.toString());
            if(!nolog) log(x.toString());
			output += x;
        });
        p.on("exit", (code) => {
			let returnObject = {'exit_code': code, 'output': output};
			if(!nolog) log('Command complete. Result: ' + JSON.stringify(returnObject, null, 2),false);
            resolveFunc(returnObject);
        });
    });
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

	/*
    fs.appendFile("log.txt", logItem + "\r\n", function (err) {
        if (err) {	
			console.log('Unable to write to log file');
			console.log(err);
		}
    });
	*/
	logEntries.push(logItem);
}

/**
 * @Description Method that executes at the end of a successful script run. Exits the program.
 */
function finish() {
    log("Process completed", true, "yellow");
    log("\r\n\r\n------------------------------------------------ ", false);
	
    fs.appendFile("log.txt", logEntries.join("\r\n"), function (err) {
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