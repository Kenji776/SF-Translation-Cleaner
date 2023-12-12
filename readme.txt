Salesforce Translation Cleaner Readme

--What does this do? What problem does it solve?

This application was born from the need to create a secondary Salesforce org that was a subset of two other merged orgs. This new org would have much of the same metadata as the others but not an exact match. The existing orgs supported multiple languages and the new one would as well, so the translation data had to be moved over. The problem was that the translation files could not be imported 'as is' from the export as they contained references to things that did not exist in the new org. Salesforce has made the decision to enforce 'all or nothing' on language imports so if anything fails the entire job fails. So the problem is that all invalid references coming from the old source orgs had to be removed so the translations could be loaded into the new org. This application is an attempt at doing so.

--How does it work?

The approach is fairly simple. 

1) Download all translatable metadata from your target org to your local machine (custom fields, objects, tabs, etc)
2) The script runs line by line looking at each translation. For every translation check to see if the referenced metadata exists.
3) Remove any translation lines that reference non-existant metadata.
4) Save the resulting 'cleaned' translation file.

--How to use it?

1) Use the included package.xml to pull down all the needed metadata. For elements that do not support wildcards I suggest using the 'Salesforce Package.xml Generator Extension for VS Code' VS code extension. This will help you generate a package.xml file that will pull all the needed metadata types. A complete list of all required types is included below.

2) Modify the config.json file as needed (if needed). In most cases there shouldn't be any need to change this, except MAYBE the orgDataLocation (personally I copy the project folder into this script folder when running it just to keep my main project folder clean). 

3) Use the Salesforce translation workbench to export all the bilingual translation files from your source org. Download each .stf file (or .xlf files. My orgs refused to export these but theoretically would work better). Once downloaded put them into whatever folder is designated as your 'sourceDir' in your config.json file.

4) Run the script (either using the included batch file if on windows or just use the console command 'node index.js' no quotes). If everything was found and is processing correctly it should generate a large amount of output in most cases. If there are errors check your file paths and make sure all referenced folders in the config.json exist. 

5) Zip all of the files generated in the 'output' directory. Use the translation workbench to import it. If errors occur you can download the error logs and place them into the errorLogLocation folder specified in your config.json. Any logs there will be processed and any 'invalid key' translation elements will automatically be skipped on the next generation run. These are elements that for some reason or another don't exist in your org but the script was unable to detect that. If your translation file loaded with no issues then you don't need to worry about this step.

If you encounter errors other than 'invalid key' you'll have to do some more investigation. The notes.txt file contains a bit of debugging information.



--Prerequisites

To use this script you must have the following.
- NodeJs installed
- A local download of your org metadata (use the provided package.xml, you'll have to specify components that don't allow wildcard downloads)

--Output File Descriptions

The script generates a number of output files during its execution. Most of them are information but may be useful in debugging errors or putting together summary reports.

addressData.json: A JSON dump of the constructed object created by processing the address data settings file. The program keys the data by country ISO code, then state ISO code for easier lookups when processing. If anything seems off about your addressCountry or addressState data checking this file may be helpful in understanding what happened. Otherwise it can be ignored.

invalidTranslationEntries.json:  a JSON dump of all the elements collected from the error logs in the errorLogLocation folder. These elements will be excluded from the translation outputs as they were found in a previous run to cause failures. 

output->metadata_[input file name].stf: Results of script run/cleaning. Importable stf files that can be uploaded to Salesforce.

output->metadata_[input file name].stf.log: A log of the results of processing the stf file. Informational only.

removedTranslations->[input file name].stf: A log of all translations that were found to be invalid for the given file.

log.txt: An log of all the operations that happened during the last script execution run.

errors.txt: A subset of the log.txt that contains only errors that should be addressed.

Translation Cleaing Final Report.csv: A CSV report that contains a summary of all the cleaned translations.

--What is translationChunker.bat/translationChunker.js?

TranslationChunker allows the resulting translation files to be broken into smaller chunks in case the output of a the resulting files is too large for import or causing errors. It will take the created cleaned translations and further break them down into files for [object][metadataType] instead of just [object]. In the config.json you can additionally set it to separate the files based on the [object][metadataType][fieldName] but this isn't recommended due to the number of ouptut files.