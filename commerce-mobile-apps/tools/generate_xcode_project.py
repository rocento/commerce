"""Generate native merchant apps with published settings and local fixture apps."""
import argparse
import hashlib
from pathlib import Path
import plistlib
ROOT=Path(__file__).resolve().parents[1]/'ios'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true', help='Fail on generated project or scheme drift without writing files')
args=parser.parse_args()
outputs={}
def output(path, content):
 outputs[path]=content.encode() if isinstance(content,str) else content
objects={}
def ident(key):return hashlib.sha1(key.encode()).hexdigest()[:24].upper()
def obj(key,isa,**args):
 i=ident(key);objects[i]={'isa':isa,**args};return i
def encode(v):
 if isinstance(v,dict):return '{\n'+''.join(f'{encode(k)} = {encode(x)};\n' for k,x in v.items())+'}'
 if isinstance(v,list):return '('+','.join(encode(x) for x in v)+')'
 return '"'+str(v).replace('\\','\\\\').replace('"','\\"')+'"'
files=[obj(f'f:{name}','PBXFileReference',lastKnownFileType='sourcecode.swift',path=name,sourceTree='<group>') for name in sorted(str(p.relative_to(ROOT)) for p in (ROOT/'Storefront').glob('*.swift'))]
accountIcon=obj('account-icon','PBXFileReference',lastKnownFileType='folder.assetcatalog',path='Storefront/Assets.xcassets',sourceTree='<group>')
privacy=obj('privacy-manifest','PBXFileReference',lastKnownFileType='text.xml',path='Storefront/PrivacyInfo.xcprivacy',sourceTree='<group>')
integrationFiles={kind:obj('integration:'+kind,'PBXFileReference',lastKnownFileType='sourcecode.swift',path='Integrations/'+kind+'/StorefrontIntegration.swift',sourceTree='<group>') for kind in ['Standalone','AppBuilder']}
testFile=obj('testfile','PBXFileReference',lastKnownFileType='sourcecode.swift',path='StorefrontUITests/StorefrontUITests.swift',sourceTree='<group>')
testResource=obj('testresource','PBXFileReference',lastKnownFileType='text.json',path='RocentoCore/Tests/RocentoCoreTests/Resources/commerce-flow.json',sourceTree='<group>')
package=obj('core','XCLocalSwiftPackageReference',relativePath='RocentoCore')
builderPackage=obj('builder-package','XCLocalSwiftPackageReference',relativePath='RocentoAppBuilder')
products=[];targets=[]
def configs(key,settings):
 ids=[obj(key+v,'XCBuildConfiguration',name=v,buildSettings={**settings,'SWIFT_OPTIMIZATION_LEVEL':'-Onone' if v=='Debug' else '-O','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'DEBUG' if v=='Debug' else '', 'DEBUG_INFORMATION_FORMAT':'dwarf','ONLY_ACTIVE_ARCH':'YES' if v=='Debug' else 'NO'}) for v in ['Debug','Release']]
 return obj(key+'configs','XCConfigurationList',buildConfigurations=ids,defaultConfigurationIsVisible=0,defaultConfigurationName='Debug')
projectId=ident('project')
production={'Rocento':('grocery','312f9ac8-4888-4d35-92a0-e5fdb3bf59b8'),'Electronics':('electronics','07cccc3d-6a89-5f7d-811c-c5ff9b1de2ca'),'Jewelry':('jewelry','93182ade-4864-50f7-ac66-ad8a4bc7b5f0'),'Pharmacy':('pharmacy','f2c2b1ec-b9ea-53e3-9800-a61f9cd1dc86')}
apps=[('Market',1),('Boutique',2)]+[(name,1) for name in production]
for baseName,merchant in apps:
 builderEnabled=baseName in production
 name=baseName
 appId=ident(name)
 product=obj(name+'app','PBXFileReference',explicitFileType='wrapper.application',path=name+'.app',sourceTree='BUILT_PRODUCTS_DIR');products.append(product)
 dep=obj(name+'core','XCSwiftPackageProductDependency',package=package,productName='RocentoCore')
 linked=obj(name+'framework','PBXBuildFile',productRef=dep)
 deps=[dep]; links=[linked]
 if builderEnabled:
  builderDep=obj(name+'builder','XCSwiftPackageProductDependency',package=builderPackage,productName='RocentoAppBuilder')
  deps.append(builderDep);links.append(obj(name+'builderFramework','PBXBuildFile',productRef=builderDep))
 targetFiles=files+[integrationFiles['AppBuilder' if builderEnabled else 'Standalone']]
 source=obj(name+'sources','PBXSourcesBuildPhase',buildActionMask=2147483647,files=[obj(name+f,'PBXBuildFile',fileRef=f) for f in targetFiles],runOnlyForDeploymentPostprocessing=0)
 resources=obj(name+'resources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=[obj(name+'account-icon-build','PBXBuildFile',fileRef=accountIcon),obj(name+'privacy-build','PBXBuildFile',fileRef=privacy)],runOnlyForDeploymentPostprocessing=0)
 frameworks=obj(name+'frameworks','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=links,runOnlyForDeploymentPostprocessing=0)
 settings={'PRODUCT_BUNDLE_IDENTIFIER':('com.rocento.'+production[baseName][0] if baseName in production else 'com.rocento.mobile.preview.'+name.lower()),'PRODUCT_NAME':name,'SWIFT_VERSION':'5.0','SWIFT_STRICT_CONCURRENCY':'complete','IPHONEOS_DEPLOYMENT_TARGET':'17.0','TARGETED_DEVICE_FAMILY':'1,2','SDKROOT':'iphoneos','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','INFOPLIST_FILE':'Storefront/Info.plist','ROCENTO_PUSH_ENABLED':'NO','ROCENTO_BUILDER_ORIGIN':'https://grocery.rocento.com/api' if builderEnabled else '','ROCENTO_MERCHANT':merchant,'ROCENTO_PRODUCTION':'YES' if baseName in production else 'NO','CODE_SIGN_STYLE':'Automatic','CURRENT_PROJECT_VERSION':'5','MARKETING_VERSION':'1.3.0','ROCENTO_STORE':production.get(baseName,('grocery',''))[0],'ROCENTO_TENANT':production.get(baseName,('',''))[1]}
 targets.append(obj(name,'PBXNativeTarget',name=name,buildConfigurationList=configs(name,settings),buildPhases=[source,resources,frameworks],buildRules=[],dependencies=[],packageProductDependencies=deps,productName=name,productReference=product,productType='com.apple.product-type.application'))
 testName=name+'UITests';testProduct=obj(testName+'product','PBXFileReference',explicitFileType='wrapper.cfbundle',path=testName+'.xctest',sourceTree='BUILT_PRODUCTS_DIR');products.append(testProduct)
 proxy=obj(testName+'proxy','PBXContainerItemProxy',containerPortal=projectId,proxyType=1,remoteGlobalIDString=appId,remoteInfo=name)
 dependency=obj(testName+'dependency','PBXTargetDependency',target=appId,targetProxy=proxy)
 testSource=obj(testName+'sources','PBXSourcesBuildPhase',buildActionMask=2147483647,files=[obj(testName+'file','PBXBuildFile',fileRef=testFile)],runOnlyForDeploymentPostprocessing=0)
 testResources=obj(testName+'resources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=[obj(testName+'resource','PBXBuildFile',fileRef=testResource)],runOnlyForDeploymentPostprocessing=0)
 testSettings={k:v for k,v in settings.items() if k not in ['INFOPLIST_FILE','ROCENTO_MERCHANT']};testSettings.update({'PRODUCT_NAME':testName,'PRODUCT_BUNDLE_IDENTIFIER':'com.rocento.mobile.preview.'+testName.lower(),'GENERATE_INFOPLIST_FILE':'NO','INFOPLIST_FILE':'StorefrontUITests/Info.plist','TEST_TARGET_NAME':name})
 testId=obj(testName,'PBXNativeTarget',name=testName,buildConfigurationList=configs(testName,testSettings),buildPhases=[testSource,testResources],buildRules=[],dependencies=[dependency],productName=testName,productReference=testProduct,productType='com.apple.product-type.bundle.ui-testing');targets.append(testId)
 schemes=ROOT/'RocentoMobile.xcodeproj/xcshareddata/xcschemes'
 ref=lambda target,product:f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident(target)}" BuildableName="{product}" BlueprintName="{target}" ReferencedContainer="container:RocentoMobile.xcodeproj"/>'
 output(schemes/(name+'.xcscheme'), f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2620" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref(name,name+'.app')}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref(testName,testName+'.xctest')}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref(name,name+'.app')}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref(name,name+'.app')}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>\n''')
# Legacy scheme names forward to the same target/product while callers migrate.
for name in production:
 output(schemes/(name+'Studio.xcscheme'), outputs[schemes/(name+'.xcscheme')])
productGroup=obj('products','PBXGroup',children=products,name='Products',sourceTree='<group>')
mainGroup=obj('main','PBXGroup',children=files+[accountIcon,privacy]+list(integrationFiles.values())+[testFile,testResource,productGroup],sourceTree='<group>')
obj('project','PBXProject',attributes={'LastUpgradeCheck':'2620'},buildConfigurationList=configs('project',{'CLANG_ENABLE_MODULES':'YES','SWIFT_VERSION':'5.0','SWIFT_STRICT_CONCURRENCY':'complete'}),compatibilityVersion='Xcode 14.0',developmentRegion='en',hasScannedForEncodings=0,knownRegions=['en','ar','Base'],mainGroup=mainGroup,productRefGroup=productGroup,projectDirPath='',projectRoot='',targets=targets,packageReferences=[package,builderPackage])
output(ROOT/'RocentoMobile.xcodeproj/project.pbxproj', '// !$*UTF8*$!\n'+encode({'archiveVersion':1,'classes':{},'objectVersion':56,'objects':objects,'rootObject':projectId})+'\n')
info={'CFBundleIdentifier':'$(PRODUCT_BUNDLE_IDENTIFIER)','CFBundleName':'$(PRODUCT_NAME)','CFBundleExecutable':'$(EXECUTABLE_NAME)','CFBundlePackageType':'APPL','CFBundleVersion':'$(CURRENT_PROJECT_VERSION)','CFBundleShortVersionString':'$(MARKETING_VERSION)','RocentoPushEnabled':'$(ROCENTO_PUSH_ENABLED)','RocentoBuilderOrigin':'$(ROCENTO_BUILDER_ORIGIN)','RocentoMerchant':'$(ROCENTO_MERCHANT)','RocentoProduction':'$(ROCENTO_PRODUCTION)','RocentoStore':'$(ROCENTO_STORE)','RocentoTenant':'$(ROCENTO_TENANT)','NSLocationWhenInUseUsageDescription':'Choose your delivery pin and check delivery coverage.','UIUserInterfaceStyle':'Light','UILaunchScreen':{},'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight']}
output(ROOT/'Storefront/Info.plist', plistlib.dumps(info))
testInfo={'CFBundleIdentifier':'$(PRODUCT_BUNDLE_IDENTIFIER)','CFBundleName':'$(PRODUCT_NAME)','CFBundleExecutable':'$(EXECUTABLE_NAME)','CFBundlePackageType':'BNDL','CFBundleVersion':'$(CURRENT_PROJECT_VERSION)','CFBundleShortVersionString':'$(MARKETING_VERSION)','RocentoProduction':'$(ROCENTO_PRODUCTION)'}
output(ROOT/'StorefrontUITests/Info.plist', plistlib.dumps(testInfo))
if args.check:
 stale=[str(path.relative_to(ROOT)) for path,data in outputs.items() if not path.is_file() or path.read_bytes()!=data]
 if stale:
  raise SystemExit('Generated Xcode wiring is stale; run commerce-mobile-apps/tools/generate_xcode_project.py: '+', '.join(stale))
 print('Generated Xcode wiring is current')
else:
 for path,data in outputs.items():
  path.parent.mkdir(parents=True,exist_ok=True)
  path.write_bytes(data)
 print('Generated merchant apps, local fixtures and legacy scheme aliases')
