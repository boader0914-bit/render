'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {screen,policy,welcome}=require('../web/auth.js');
test('closed signup remains discoverable without accepting credentials or silently becoming login',()=>{
  assert.match(screen({signup:false,config:{signupEnabled:false}}),/href="#signup"/);
  const closed=screen({signup:true,config:{signupEnabled:false,signupMessage:'가입 점검 중'}});
  assert.match(closed,/가입 점검 중/);assert.doesNotMatch(closed,/id="auth-form"/);assert.match(closed,/href="#login"/);
});
test('signup has explicit business choice and unchecked required consents; text is escaped',()=>{
  const html=screen({signup:true,config:{signupEnabled:true,termsUrl:'/terms',privacyUrl:'/privacy',usernameCheckEnabled:true}});
  for(const name of ['username','password','passwordConfirm','phone','email','businessStatus','agreeTerms','agreePrivacy','confirmAge'])assert.match(html,new RegExp(`name="${name}"`));
  assert.doesNotMatch(html,/\schecked(?:\s|>)/);assert.match(html,/autocomplete="new-password"/);assert.match(html,/중복 확인/);
  assert.doesNotMatch(policy({title:'<script>bad</script>',version:'v1',sections:[]},{},false),/<script>/);
  assert.match(welcome({username:'<unsafe>',businessStatus:'owned',entitlements:{competitorLimit:3}}),/내 매장 찾기/);
  assert.match(welcome({username:'planning',businessStatus:'planning',entitlements:{competitorLimit:3}}),/관심지역 선택/);
});
test('signup visibly marks required inputs and consents while leaving the project name optional',()=>{
  const html=screen({signup:true,config:{signupEnabled:true}});
  assert.match(html,/<p class="required-legend">[\s\S]*?\*<\/span> 필수 입력<\/p>/);
  const labels=html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g)||[];
  for(const name of ['username','password','passwordConfirm','phone','email','agreeTerms','agreePrivacy','confirmAge']){
    const label=labels.find(item=>item.includes(`name="${name}"`));
    assert.ok(label,`${name} has a label`);
    assert.match(label,/<span class="required-marker" aria-hidden="true"> \*<\/span>/,`${name} is visibly required`);
    assert.match(label,/<input\b[^>]*\srequired(?:\s|>)/,`${name} keeps browser validation`);
  }
  assert.match(html,/<fieldset class="business-choices"><legend>[^<]*<span class="required-marker" aria-hidden="true"> \*<\/span><\/legend>/);
  const optional=labels.find(item=>item.includes('name="projectName"'));
  assert.match(optional,/\(선택\)/);
  assert.doesNotMatch(optional,/required-marker|\srequired(?:\s|>)/);
  assert.doesNotMatch(html,/\schecked(?:\s|>)/);
});
test('required signup guidance is absent from login and unavailable signup',()=>{
  assert.doesNotMatch(screen({signup:false,config:{signupEnabled:true}}),/required-marker|required-legend/);
  assert.doesNotMatch(screen({signup:true,config:{signupEnabled:false}}),/required-marker|required-legend/);
});
